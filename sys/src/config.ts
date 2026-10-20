import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'yaml';
import { z } from 'zod';

const vaultSchema = z.object({
  name: z.string().optional(),
  description: z.string().default(''),
  path: z.string().min(1),
});

const configSchema = z.object({
  server: z.object({ host: z.string().default('127.0.0.1'), port: z.number().int().min(1).max(65535).default(8300) }).default({}),
  data_dir: z.string().min(1).default('..'),
  vaults: z.record(z.string().regex(/^[a-zA-Z0-9_-]+$/).refine(id => id !== 'default', 'default is reserved'), vaultSchema).default({}),
  search: z.object({ results_per_page: z.number().int().min(1).max(100).default(20) }).default({}),
});

export type Config = z.infer<typeof configSchema>;

export function createConfig(input: unknown = {}, base = process.cwd()): Config {
  const result = configSchema.safeParse(input);
  if (!result.success) throw new Error(`Invalid configuration: ${result.error.issues.map(i => i.path.join('.') + ' ' + i.message).join('; ')}`);
  const config = result.data;
  config.data_dir = resolve(base, config.data_dir);
  for (const vault of Object.values(config.vaults)) vault.path = resolve(base, vault.path);
  return config;
}

export function loadConfig(): Config {
  const filename = resolve(process.env.CORAL_CONFIG ?? fileURLToPath(new URL('../config.yaml', import.meta.url)));
  if (process.env.CORAL_CONFIG && !existsSync(filename)) throw new Error('CORAL_CONFIG does not exist');
  const raw: unknown = existsSync(filename) ? parse(readFileSync(filename, 'utf8')) ?? {} : {};
  const config = createConfig(raw, dirname(filename));
  if (process.env.CORAL_DATA_DIR) config.data_dir = resolve(process.env.CORAL_DATA_DIR);
  if (process.env.CORAL_HOST) config.server.host = process.env.CORAL_HOST;
  if (process.env.CORAL_PORT) config.server.port = z.coerce.number().int().min(1).max(65535).parse(process.env.CORAL_PORT);
  return config;
}
