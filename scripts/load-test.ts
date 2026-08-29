import "dotenv/config";
import { randomUUID } from "node:crypto";
import { Pool } from "pg";

const databaseUrl = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
if (!databaseUrl) throw new Error("TEST_DATABASE_URL or DATABASE_URL is required");
const records = Math.min(Number(process.env.LOAD_RECORDS ?? 100_000), 2_000_000);
const pool = new Pool({ connectionString: databaseUrl });
const suffix = randomUUID().slice(0, 8);

try {
  const organisation = await pool.query<{ id: string }>("INSERT INTO organisations (name) VALUES ($1) RETURNING id", [`Load Test ${suffix}`]);
  const organisationId = organisation.rows[0].id;
  const device = await pool.query<{ id: string }>("INSERT INTO devices (organisation_id, name, os, public_key) VALUES ($1, $2, 'Windows', $3) RETURNING id", [organisationId, `LOAD-PC-${suffix}`, `load-key-${suffix}`]);
  const root = await pool.query<{ id: string }>("INSERT INTO indexed_roots (organisation_id, device_id, canonical_path) VALUES ($1, $2, 'D:\\LoadTest') RETURNING id", [organisationId, device.rows[0].id]);
  const started = performance.now();
  await pool.query(
    `INSERT INTO files (organisation_id, device_id, root_id, stable_file_id, name, normalized_name, relative_path, normalized_relative_path, extension, size_bytes, modified_at)
     SELECT $1, $2, $3, 'load:' || n, 'project_report_' || n || '.pdf', 'project_report_' || n || '.pdf',
            'generated/project_report_' || n || '.pdf', 'generated/project_report_' || n || '.pdf', 'pdf', n * 100, now() - (n || ' seconds')::interval
       FROM generate_series(1, $4) n`,
    [organisationId, device.rows[0].id, root.rows[0].id, records]
  );
  console.log(`Inserted ${records.toLocaleString()} records in ${Math.round(performance.now() - started)} ms`);
  for (const term of ["project_report_42.pdf", "project_report_42", "report_9999"]) {
    const queryStarted = performance.now();
    const result = await pool.query(
      `SELECT id FROM files WHERE organisation_id = $1 AND deleted_at IS NULL
        AND (normalized_name % $2 OR normalized_name LIKE $2 || '%')
        ORDER BY CASE WHEN normalized_name = $2 THEN 0 ELSE 1 END, similarity(normalized_name, $2) DESC LIMIT 50`,
      [organisationId, term]
    );
    console.log(`${term}: ${result.rowCount} results in ${(performance.now() - queryStarted).toFixed(1)} ms`);
  }
} finally {
  await pool.query("DELETE FROM organisations WHERE name = $1", [`Load Test ${suffix}`]).catch(() => undefined);
  await pool.end();
}

