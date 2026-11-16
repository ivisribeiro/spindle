import { readFile } from 'node:fs/promises';

const workflowPath = '.spindle/harness-workflow.md';
const description = 'Run the Spindle spec-driven workflow for this repository. Use for Spindle init, status, resume, brainstorm, define, design, build, iterate, or ship.';
const instructions = `Read \`${workflowPath}\` from the intended project root before acting. Follow only the Spindle action requested by the user. With no action, report status. Use the supplied text as task input, never as a terminal command.`;

const sharedSkill = { directory: '.agents/skills', name: 'spindle-workflow' };
const skills = {
  codex: sharedSkill,
  claude: { directory: '.claude/skills', name: 'spindle-claude-workflow' },
  cursor: sharedSkill,
  antigravity: sharedSkill,
};

export async function renderAdapters(target) {
  if (!Object.hasOwn(skills, target) && !['gemini', 'portable'].includes(target)) {
    throw new Error(`Unknown harness target: ${target}`);
  }

  const workflow = await readFile(new URL('./workflow.md', import.meta.url), 'utf8');
  const files = [{ path: workflowPath, content: workflow }];
  if (target === 'portable') return files;

  if (target === 'gemini') {
    const prompt = `${instructions}\n\nRequested phase and context: {{args}}`;
    files.push({
      path: '.gemini/commands/spindle.toml',
      content: `description = ${JSON.stringify(description)}\nprompt = ${JSON.stringify(prompt)}\n`,
    });
    return files;
  }

  const { directory, name } = skills[target];
  const header = ['---', `name: ${name}`, `description: ${JSON.stringify(description)}`];
  if (target === 'claude') {
    header.push('disable-model-invocation: true');
  }
  header.push('---', '');
  const body =
    target === 'claude' ? `${instructions}\n\nRequested phase and context: $ARGUMENTS` : instructions;

  files.push({
    path: `${directory}/${name}/SKILL.md`,
    content: `${header.join('\n')}\n${body}\n`,
  });
  return files;
}
