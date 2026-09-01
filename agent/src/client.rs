use std::fs;
use std::io::BufReader;
use std::path::Path;
use std::sync::Arc;
use std::time::Duration;

use anyhow::{Context, Result};
use base64::Engine;
use chrono::Utc;
use ed25519_dalek::{Signer, SigningKey};
use futures_util::{SinkExt, StreamExt};
use http::Request;
use reqwest::{Client, StatusCode};
use rustls::{ClientConfig, RootCertStore};
use serde::Serialize;
use tokio::sync::mpsc::Sender;
use tokio::time::interval;
use tokio_tungstenite::{Connector, connect_async_tls_with_config, tungstenite::Message};
use uuid::Uuid;

use crate::models::{
    BatchAcknowledgement, CommandAcknowledgement, CommandList, EventBatch, FileEvent,
};

#[derive(Clone)]
pub struct CoordinatorClient {
    http: Client,
    base_url: String,
    agent_token: String,
    device_signing_key: Option<SigningKey>,
    socket_tls: Arc<ClientConfig>,
}

impl CoordinatorClient {
    pub fn new(
        base_url: String,
        agent_token: String,
        device_signing_key: Option<String>,
        certificate: Option<&Path>,
        private_key: Option<&Path>,
        coordinator_ca: Option<&Path>,
    ) -> Result<Self> {
        let mut builder = Client::builder()
            .https_only(
                !base_url.starts_with("http://127.0.0.1")
                    && !base_url.starts_with("http://localhost"),
            )
            .timeout(std::time::Duration::from_secs(30));
        if let (Some(certificate), Some(private_key)) = (certificate, private_key) {
            let mut identity_pem = fs::read(certificate)
                .with_context(|| format!("read client certificate {}", certificate.display()))?;
            identity_pem.extend_from_slice(
                &fs::read(private_key)
                    .with_context(|| format!("read client key {}", private_key.display()))?,
            );
            builder = builder.identity(
                reqwest::Identity::from_pem(&identity_pem).context("parse mTLS client identity")?,
            );
        }
        if let Some(coordinator_ca) = coordinator_ca {
            let ca = fs::read(coordinator_ca)
                .with_context(|| format!("read coordinator CA {}", coordinator_ca.display()))?;
            builder = builder.add_root_certificate(
                reqwest::Certificate::from_pem(&ca).context("parse coordinator CA")?,
            );
        }
        let http = builder.build()?;
        let socket_tls = Arc::new(socket_tls_config(certificate, private_key, coordinator_ca)?);
        let device_signing_key = device_signing_key
            .as_deref()
            .map(crate::identity::signing_key_from_base64)
            .transpose()?;
        Ok(Self {
            http,
            base_url: base_url.trim_end_matches('/').to_owned(),
            agent_token,
            device_signing_key,
            socket_tls,
        })
    }

    pub async fn upload_events(&self, events: Vec<FileEvent>) -> Result<u64> {
        let acknowledgement: BatchAcknowledgement = self
            .send(
                self.http
                    .post(self.url("/api/v1/agent/events/batch"))
                    .json(&EventBatch { events }),
            )
            .await?
            .json()
            .await?;
        Ok(acknowledgement.acknowledged_sequence)
    }

    pub async fn heartbeat(&self) -> Result<()> {
        self.send(self.http.post(self.url("/api/v1/agent/heartbeat")))
            .await?;
        Ok(())
    }

    pub async fn commands(&self) -> Result<CommandList> {
        Ok(self
            .send(self.http.get(self.url("/api/v1/agent/commands")))
            .await?
            .json()
            .await?)
    }

    pub async fn live_notifications(&self, notifications: Sender<()>) -> Result<()> {
        let socket_url = self
            .url("/api/v1/agent/live")
            .replacen("https://", "wss://", 1)
            .replacen("http://", "ws://", 1);
        let mut request = Request::builder()
            .uri(socket_url)
            .header("Authorization", format!("Bearer {}", self.agent_token))
            .header("Sec-WebSocket-Protocol", "filefinder.agent.v1")
            .body(())?;
        self.sign_headers(request.headers_mut(), "GET", "/api/v1/agent/live")?;
        let (mut socket, _) = connect_async_tls_with_config(
            request,
            None,
            false,
            Some(Connector::Rustls(self.socket_tls.clone())),
        )
        .await
        .context("connect agent live channel")?;
        let mut heartbeat = interval(Duration::from_secs(30));
        loop {
            tokio::select! {
                _ = heartbeat.tick() => socket.send(Message::Text("{\"type\":\"HEARTBEAT\"}".into())).await?,
                incoming = socket.next() => {
                    let Some(message) = incoming else { anyhow::bail!("live channel closed"); };
                    let message = message?;
                    if let Message::Text(text) = message {
                        let value: serde_json::Value = serde_json::from_str(&text)?;
                        if value.get("type").and_then(|kind| kind.as_str()) == Some("COMMAND_AVAILABLE") {
                            let _ = notifications.send(()).await;
                        }
                    }
                }
            }
        }
    }

    pub async fn acknowledge_command(
        &self,
        command_id: Uuid,
        acknowledgement: CommandAcknowledgement<'_>,
    ) -> Result<()> {
        self.send(
            self.http
                .post(self.url(&format!("/api/v1/agent/commands/{command_id}/ack")))
                .json(&acknowledgement),
        )
        .await?;
        Ok(())
    }

    pub async fn start_reconciliation(&self, root_id: Uuid) -> Result<Uuid> {
        #[derive(Serialize)]
        #[serde(rename_all = "camelCase")]
        struct Request {
            root_id: Uuid,
        }
        #[derive(serde::Deserialize)]
        struct Response {
            id: Uuid,
        }
        Ok(self
            .send(
                self.http
                    .post(self.url("/api/v1/agent/reconciliations"))
                    .json(&Request { root_id }),
            )
            .await?
            .json::<Response>()
            .await?
            .id)
    }

    pub async fn upload_reconciliation_chunk(
        &self,
        session_id: Uuid,
        entries: &[FileEvent],
    ) -> Result<()> {
        #[derive(Serialize)]
        struct Chunk<'a> {
            entries: &'a [FileEvent],
        }
        self.send(
            self.http
                .post(self.url(&format!(
                    "/api/v1/agent/reconciliations/{session_id}/chunks"
                )))
                .json(&Chunk { entries }),
        )
        .await?;
        Ok(())
    }

    pub async fn complete_reconciliation(&self, session_id: Uuid) -> Result<()> {
        self.send(self.http.post(self.url(&format!(
            "/api/v1/agent/reconciliations/{session_id}/complete"
        ))))
        .await?;
        Ok(())
    }

    async fn send(&self, request: reqwest::RequestBuilder) -> Result<reqwest::Response> {
        let mut request = request
            .bearer_auth(&self.agent_token)
            .build()
            .context("build coordinator request")?;
        let path = match request.url().query() {
            Some(query) => format!("{}?{query}", request.url().path()),
            None => request.url().path().to_owned(),
        };
        let method = request.method().as_str().to_owned();
        self.sign_headers(request.headers_mut(), &method, &path)?;
        let response = self.http
            .execute(request)
            .await
            .context("coordinator request failed")?;
        if response.status().is_success() {
            return Ok(response);
        }
        let status = response.status();
        let body = response.text().await.unwrap_or_default();
        if status == StatusCode::UNAUTHORIZED || status == StatusCode::FORBIDDEN {
            anyhow::bail!("device authentication rejected ({status}): {body}");
        }
        anyhow::bail!("coordinator returned {status}: {body}")
    }

    fn url(&self, path: &str) -> String {
        format!("{}{path}", self.base_url)
    }

    fn sign_headers(
        &self,
        headers: &mut http::HeaderMap,
        method: &str,
        path: &str,
    ) -> Result<()> {
        let Some(signing_key) = &self.device_signing_key else {
            return Ok(());
        };
        let timestamp = Utc::now().timestamp().to_string();
        let nonce = Uuid::new_v4().to_string();
        let message = format!("{timestamp}\n{nonce}\n{method}\n{path}");
        let signature = base64::engine::general_purpose::STANDARD
            .encode(signing_key.sign(message.as_bytes()).to_bytes());
        headers.insert("x-filefinder-timestamp", timestamp.parse()?);
        headers.insert("x-filefinder-nonce", nonce.parse()?);
        headers.insert("x-filefinder-signature", signature.parse()?);
        Ok(())
    }
}

fn socket_tls_config(
    certificate: Option<&Path>,
    private_key: Option<&Path>,
    coordinator_ca: Option<&Path>,
) -> Result<ClientConfig> {
    let mut roots = RootCertStore::empty();
    let native = rustls_native_certs::load_native_certs();
    for certificate in native.certs {
        roots.add(certificate)?;
    }
    if let Some(coordinator_ca) = coordinator_ca {
        for certificate in
            rustls_pemfile::certs(&mut BufReader::new(fs::File::open(coordinator_ca)?))
        {
            roots.add(certificate?)?;
        }
    }
    if let (Some(certificate), Some(private_key)) = (certificate, private_key) {
        let certificates = rustls_pemfile::certs(&mut BufReader::new(fs::File::open(certificate)?))
            .collect::<std::result::Result<Vec<_>, _>>()?;
        let key = rustls_pemfile::private_key(&mut BufReader::new(fs::File::open(private_key)?))?
            .ok_or_else(|| anyhow::anyhow!("mTLS private key file did not contain a key"))?;
        return Ok(ClientConfig::builder()
            .with_root_certificates(roots)
            .with_client_auth_cert(certificates, key)?);
    }
    Ok(ClientConfig::builder()
        .with_root_certificates(roots)
        .with_no_client_auth())
}
