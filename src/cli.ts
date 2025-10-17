#!/usr/bin/env node
import 'dotenv/config';
import { Command } from 'commander';
import chalk from 'chalk';
import { registerAllCommands } from './commands/_autoregister.js';
import { log } from './support/logger.js';

const program = new Command();
program.name('ghostable').description('Ghostable zero-knowledge CLI (experimental)');
await registerAllCommands(program);

program.showHelpAfterError();
program.configureOutput({
        outputError: (str) => process.stderr.write(chalk.red(str)),
});

if (process.argv.length <= 2) {
        program.outputHelp();
}

program.parseAsync(process.argv).catch((err) => {
        log.error(err?.stack || String(err));
        process.exit(1);
});
