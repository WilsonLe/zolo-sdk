# Encrypted transfer contract

## Supported data

Payload version 2 transfers exactly the allowlisted preferred workflow IDs,
optional default workflow ID, and optional BCP 47-style response-language tag.
Provider credentials, connector authentication, account/resource IDs, paths,
environment values, logs, caches, CLI configuration, arbitrary settings, and
free-form fields are excluded. The helper never scans provider credential stores.

Legacy payload version 1 is accepted only with its exact schema and an empty
credential map; it normalizes to version 2. Credential-bearing legacy archives
are rejected before any local writes with an instruction to reconnect through
Codex and export preferences again. No provider token is imported, silently
skipped, printed, or deleted. The user retains the original archive.

## Envelope

`.agenticx` is strict UTF-8 JSON. Visible fields identify the fixed format/envelope version, origin
plugin, mode, KDF parameters, cipher, nonce, and ciphertext. The encrypted payload uses its own
strict schema version. Unknown or missing fields fail closed.

Portable mode normalizes the passphrase with Unicode NFKC, derives a 256-bit key with the
versioned scrypt parameters in the envelope, and encrypts with AES-256-GCM. Local-session mode uses
a random 256-bit OS-user key. Canonical visible metadata is authenticated as associated data.
Any metadata, nonce, tag, or ciphertext modification makes authentication fail before parsing.

The implementation uses a pinned `cryptography` runtime dependency. It does not implement a cipher
or KDF itself.

## Mode compatibility

`local-session` is a convenience mode:

- macOS uses a Keychain item belonging to the current OS user;
- Windows uses a CurrentUser DPAPI-protected local key;
- another OS user or machine cannot decrypt the file.

`portable-passphrase` is the cross-machine and cross-OS mode. macOS and Windows use identical
UTF-8, Unicode normalization, canonical JSON, scrypt, and AES-GCM rules. No OS path or key-store
reference enters the encrypted payload.

There is no universal plugin key, self-decrypting export, plaintext mode, automatic cross-machine
fallback, or passphrase recovery. Losing the passphrase makes a portable export unrecoverable.

## Import transaction

Import authenticates and validates the complete archive before changing local
state. It applies only validated preferences through an owner-only atomic file
write. Unsafe paths or incompatible payloads block the operation. If a write
fails, report the sanitized error and inspect state before retrying; do not claim
successful application or provider verification.

Import does not install provider plugins, recreate connections, or alter provider
accounts. Both sessions must have a compatible suite; connections are managed
through Codex independently. Encryption envelope version 1 and its algorithms
remain unchanged; payload version 2 is intentionally unsupported by old importers.

## Secret handling

The passphrase is accepted only through a masked native prompt or a user-controlled terminal
`getpass` prompt. It never belongs in chat, argv, environment variables, logs, screenshots, Git,
or the export. Decrypted payloads are never emitted. Output contains only preference field names,
status, and sanitized errors; no provider verification calls occur.

Treat every `.agenticx` file as a private encrypted configuration backup: restrict access, transmit
it only through intended channels, and delete it separately when no longer needed.
