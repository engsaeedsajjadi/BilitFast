// Production entry point for customer-owned self-hosted deployments.
'use strict';
process.env.BILITFAST_SELF_HOSTED='1';
process.env.BILITFAST_DESKTOP='0';
process.env.BILITFAST_MULTIUSER='1';
process.env.BILITFAST_ENFORCE_SECURITY='1';
process.env.BILITFAST_ENFORCE_LICENSE='1';
// server.js loads .env and validates the production configuration.
// The installation marker is initialized on the first production boot.
require('./server.js');
