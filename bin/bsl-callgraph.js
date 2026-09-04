#!/usr/bin/env node
'use strict';

const { main, reportFatal } = require('../src/mcp-server.js');

main(process.argv.slice(2), { commandName: 'bsl-callgraph' }).catch(reportFatal);
