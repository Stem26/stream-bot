import { execSync } from 'child_process';

export function enableWindowsUtf8Console(): void {
  if (process.platform !== 'win32') {
    return;
  }

  try {
    execSync('chcp 65001 >nul', { stdio: 'ignore', shell: 'cmd.exe' });
  } catch {
    // ignore
  }

  if (process.stdout.isTTY) {
    process.stdout.setEncoding('utf8');
  }

  if (process.stderr.isTTY) {
    process.stderr.setEncoding('utf8');
  }
}
