use anyhow::{Context, Result};
use base64::Engine;
use ed25519_dalek::pkcs8::EncodePublicKey;
use ed25519_dalek::SigningKey;
use rand_core::OsRng;

pub struct DeviceIdentity {
    pub private_key_base64: String,
    pub public_key_spki_base64: String,
}

pub fn generate_device_identity() -> Result<DeviceIdentity> {
    let signing_key = SigningKey::generate(&mut OsRng);
    let public_der = signing_key
        .verifying_key()
        .to_public_key_der()
        .context("encode Ed25519 device public key")?;
    Ok(DeviceIdentity {
        private_key_base64: base64::engine::general_purpose::STANDARD
            .encode(signing_key.to_bytes()),
        public_key_spki_base64: base64::engine::general_purpose::STANDARD
            .encode(public_der.as_bytes()),
    })
}

pub fn signing_key_from_base64(encoded: &str) -> Result<SigningKey> {
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(encoded)
        .context("decode device signing key")?;
    let key: [u8; 32] = bytes
        .try_into()
        .map_err(|_| anyhow::anyhow!("device signing key must contain 32 bytes"))?;
    Ok(SigningKey::from_bytes(&key))
}

#[cfg(test)]
mod tests {
    use super::*;
    use ed25519_dalek::{Signer, Verifier};

    #[test]
    fn generated_identity_round_trips_and_signs() {
        let identity = generate_device_identity().expect("identity");
        let key = signing_key_from_base64(&identity.private_key_base64).expect("private key");
        let message = b"filefinder-device-proof";
        let signature = key.sign(message);
        key.verifying_key().verify(message, &signature).expect("valid signature");
        assert!(!identity.public_key_spki_base64.is_empty());
    }
}
