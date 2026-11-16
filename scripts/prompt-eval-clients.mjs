import { spawn } from 'node:child_process';

const clients = {
  codex: { executable: 'SPINDLE_EVAL_CODEX', model: 'SPINDLE_EVAL_CODEX_MODEL' },
  claude: { executable: 'SPINDLE_EVAL_CLAUDE', model: 'SPINDLE_EVAL_CLAUDE_MODEL' },
};

function clientConfig(client) {
  if (!Object.hasOwn(clients, client)) throw new Error(`Unsupported prompt eval client: ${client}`);
  const spec = clients[client];
  return {
    command: process.env[spec.executable] || client,
    model: process.env[spec.model] || null,
    executableVariable: spec.executable,
  };
}

function invoke(command, args, { cwd, input = '', timeoutMs }) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      cwd,
      stdio: ['pipe', 'pipe', 'pipe'],
      signal: AbortSignal.timeout(timeoutMs),
    });
    let stdout = '';
    let stderr = '';
    const limit = 256 * 1024;
    child.stdout.setEncoding('utf8').on('data', (chunk) => {
      stdout = (stdout + chunk).slice(-limit);
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      stderr = (stderr + chunk).slice(-limit);
    });
    child.stdin.on('error', (error) => {
      if (error.code !== 'EPIPE') reject(error);
    });
    child.stdin.end(input);
    child.once('error', reject);
    child.once('close', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function classifyFailure(client, result) {
  const diagnostic = result.stderr + result.stdout;
  if (/not logged in|not authenticated|invalid api key|authentication_error|run \/login|unauthorized/i.test(diagnostic)) {
    return `${client} authentication failed. Sign in to the client locally, then rerun the live eval.`;
  }
  if (/dns error|could not resolve|network is unreachable|failed to connect|stream disconnected|connection refused|connection reset/i.test(diagnostic)) {
    return `${client} could not connect to its model provider.`;
  }
  return `${client} exited ${result.code ?? `with signal ${result.signal}`}. Check the client in a local terminal.`;
}

export async function checkClients() {
  const metadata = {};
  for (const client of Object.keys(clients)) {
    const config = clientConfig(client);
    const result = await invoke(config.command, ['--version'], { timeoutMs: 10_000 })
      .catch((error) => {
        throw new Error(`Could not start ${client} (${error.code ?? error.name}). Set ${config.executableVariable} to a working CLI executable.`);
      });
    if (result.code !== 0) {
      throw new Error(`${classifyFailure(client, result)} Set ${config.executableVariable} to a working CLI executable.`);
    }
    metadata[client] = { version: result.stdout.trim(), model: config.model };
  }
  return metadata;
}

export async function runClient(client, { cwd, prompt, timeoutMs = 180_000 }) {
  const { command, model } = clientConfig(client);
  const args = client === 'codex'
    ? ['exec', '--sandbox', 'workspace-write', '--ephemeral', '--skip-git-repo-check', '--color', 'never']
    : [
      '--print', '--output-format', 'text', '--no-session-persistence',
      '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
      '--permission-mode', 'dontAsk',
      '--tools', 'Read,Glob,Grep,Write,Edit,Bash',
      '--allowedTools', 'Read,Glob,Grep,Write,Edit,Bash(node .spindle/harness/bin/spin.js *)',
    ];
  if (model) args.push('--model', model);
  if (client === 'codex') args.push('-');
  try {
    const result = await invoke(command, args, { cwd, input: prompt, timeoutMs });
    const output = result.stdout.trim();
    if (result.code !== 0) return { exitCode: result.code ?? 1, output: classifyFailure(client, result) };
    if (!output) return { exitCode: 1, output: `${client} exited without a response.` };
    return { exitCode: 0, output };
  } catch (error) {
    if (error.name === 'AbortError') {
      return { exitCode: 1, output: `${client} exceeded the eval timeout.` };
    }
    throw new Error(`Could not start ${client} (${error.code ?? error.name}).`);
  }
}
