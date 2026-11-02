This folder needs license-public.pem from the EXISTING seller Ed25519 signing key.
On seller machine: node scripts/license-admin.js init
This operation restores/verifies the public key but REFUSES to generate a new key silently.
For a first-time seller with no previous customers: set BILITFAST_ALLOW_NEW_VENDOR_KEY=1 and use init-new deliberately.
NEVER include the seller private key in the customer ZIP.
Trial works without the public key. Permanent offline activation requires it.
Before packaging: npm run check:delivery (with no .env or local data in source).
