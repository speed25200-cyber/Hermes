"use strict";

const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const test = require("node:test");

const CLI = require("../deploy/compiler_preuve_quantitative.js");
const Q = require("../modules/quant_validation.js");

test("quant compiler accepts only public Ed25519 material and has no signing flag", (context) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), "hermes-quant-key-"));
  context.after(() => fs.rmSync(directory, { recursive: true, force: true }));
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const publicFile = path.join(directory, "public.pem");
  const privateFile = path.join(directory, "private.pem");
  const mixedFile = path.join(directory, "mixed.pem");
  fs.writeFileSync(publicFile, publicKey.export({ type: "spki", format: "pem" }));
  fs.writeFileSync(privateFile, privateKey.export({ type: "pkcs8", format: "pem" }));
  fs.writeFileSync(mixedFile, `${publicKey.export({ type: "spki", format: "pem" })}\n`
    + "-----BEGIN OPENSSH PRIVATE KEY-----\nforbidden\n-----END OPENSSH PRIVATE KEY-----\n");
  assert.equal(Q.publicKeySpkiSha256(CLI.readPublicKeyOnly(publicFile, true)),
    Q.publicKeySpkiSha256(publicKey));
  assert.throws(() => CLI.readPublicKeyOnly(privateFile, true), /cle privee est interdite/);
  assert.throws(() => CLI.readPublicKeyOnly(mixedFile, true), /cle privee est interdite/);
  assert.equal(Q.publicKeySpkiSha256(fs.readFileSync(mixedFile, "utf8")), null);
  assert.throws(() => CLI.parseArgs(["--input", "run.json", "--output", "proof.json", "--sign", privateFile]),
    /argument inconnu/);
});

test("quant CLI makes catalog id and catalog path an inseparable explicit pair", () => {
  assert.throws(() => CLI.parseArgs(["--input", "run.json", "--output", "proof.json",
    "--candidate-catalog", "candidates.json"]), /usage/);
  const parsed = CLI.parseArgs(["--input", "run.json", "--output", "proof.json",
    "--candidate-catalog", "candidates.json", "--candidate-id", "a".repeat(64),
    "--execution-attestation-public-key", "execution.pem",
    "--execution-attestation-spki-sha256", "b".repeat(64),
    "--cycle-ledger-attestation-public-key", "cycle.pem",
    "--cycle-ledger-attestation-spki-sha256", "c".repeat(64),
    "--expected-policy-sha256", "d".repeat(64)]);
  assert.equal(parsed.candidateCatalog, "candidates.json");
  assert.equal(parsed.candidateId, "a".repeat(64));
  assert.equal(parsed.executionAttestationPublicKey, "execution.pem");
  assert.equal(parsed.cycleLedgerAttestationPublicKey, "cycle.pem");
  assert.equal(parsed.expectedPolicySha256, "d".repeat(64));
});
