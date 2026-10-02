// ALF-7 (found by the ALF-8 stress test) — file content written with a heredoc is not a command: an agent
// appending code that mentions "git push" must not trip the guard. Anything that can run a heredoc body
// still does.
import { describe, it, expect } from 'vitest';
import { guardCommand, stripDataHeredocs } from '../../src/approvals.js';

const body = ['// the decision layer cleared `git push spark …`', "const s = 'git push origin main';", 'export const x = 1;'].join('\n');

describe('heredoc bodies and the guards', () => {
  it('ignores content written to a file with cat / tee', () => {
    expect(guardCommand(`cat >> web/src/views/goal/model.js <<'EOF'\n${body}\nEOF`)).toBeNull();
    expect(guardCommand(`cat > a.js <<EOF\n${body}\nEOF\necho done`)).toBeNull();
    expect(guardCommand(`tee notes.md <<"EOF" >/dev/null\nsudo rm -rf / and git push\nEOF`)).toBeNull();
    expect(guardCommand(`cat > a.sh <<-EOF\n\tgit push origin main\n\tEOF`)).toBeNull();
  });

  it('still guards anything that can run the body, or what follows it', () => {
    expect(guardCommand(`bash <<'EOF'\ngit push origin main\nEOF`)).toBe('git push'); // a shell runs it
    expect(guardCommand(`cat <<EOF | bash\ngit push origin main\nEOF`)).toBe('git push'); // piped into a shell
    expect(guardCommand(`bash -c "$(cat <<EOF\ngit push origin main\nEOF\n)"`)).toBe('git push');
    expect(guardCommand(`ssh host <<EOF\nls\nEOF`)).toBe('ssh');
    expect(guardCommand(`cat > a <<EOF\ngit push origin main`)).toBe('git push'); // unterminated: kept
    expect(guardCommand(`cat > a <<EOF\nx\nEOF\ngit push origin main`)).toBe('git push'); // after the body
    expect(guardCommand('git push origin main')).toBe('git push');
    expect(guardCommand('git push spark HEAD:alfred/x/1')).toBeNull(); // the hub stays exempt
  });

  it('keeps the lines around the body', () => {
    expect(stripDataHeredocs(`echo a\ncat > f <<EOF\nsecret body\nEOF\necho b`)).toBe(`echo a\ncat > f <<EOF\nEOF\necho b`);
  });
});

describe('a mention is not a push (ALF-8, second false positive)', () => {
  it('ignores git push / npm publish / docker push inside strings of a plain command', () => {
    expect(guardCommand(`echo "next: git push origin main"`)).toBeNull();
    expect(guardCommand(`git commit -qm "push the graph view"`)).toBeNull();
    expect(guardCommand(`grep -n "npm publish" README.md`)).toBeNull();
    expect(guardCommand(`echo 'docker push x'`)).toBeNull();
  });

  it('still catches every real invocation', () => {
    expect(guardCommand('cd web && git push origin main')).toBe('git push');
    expect(guardCommand('git -C /srv/x push origin HEAD')).toBe('git push');
    expect(guardCommand('GIT_SSH_COMMAND=x git --no-pager push')).toBe('git push');
    expect(guardCommand('time git push origin')).toBe('git push');
    expect(guardCommand('echo ok; git push')).toBe('git push');
    expect(guardCommand('npm publish --access public')).toBe('npm publish');
    expect(guardCommand('pnpm -r publish')).toBe('npm publish');
    expect(guardCommand('docker push img:1')).toBe('docker push');
    expect(guardCommand('gh pr create -f')).toBe('gh pr');
  });

  it('under a nested interpreter every mention counts — except pushes to the hub', () => {
    expect(guardCommand(`node -e "require('child_process').execSync('git push origin main')"`)).toBe('git push');
    expect(guardCommand(`bash -c "git push"`)).toBe('git push');
    expect(guardCommand(`node -e "console.log(line({ detail: 'git push spark alfred/g/x' }))"`)).toBeNull();
    expect(guardCommand(`python3 -c "print('git push spark HEAD:alfred/x/1')"`)).toBeNull();
  });
});
