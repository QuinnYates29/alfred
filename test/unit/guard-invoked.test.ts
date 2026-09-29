// Shell guards match commands that are RUN, not words inside quotes/arguments
// (false positives parked the 2026-09-29 8am automation twice).
import { describe, it, expect } from 'vitest';
import { guardCommand, invokedCommands } from '../../src/approvals.js';

describe('guardCommand — command position', () => {
  const cases: [string, string | null][] = [
    [`date -s; echo "---"; timedatectl 2>/dev/null || cat /etc/timezone; echo "---"; which sqlite3 python3 curl journalctl systemctl git; echo "---"; ls -la ~/.alfred/ 2>&1 | head -50`, null],
    [`echo "=== restart-ish sudo commands in auth.log ==="; grep -iE 'systemctl.*alfred|alfred' /var/log/auth.log 2>&1 | head -12`, null],
    [`sudo systemctl restart alfred`, 'sudo'],
    [`ls && sudo rm x`, 'sudo'],
    [`FOO=1 sudo ls`, 'sudo'],
    [`bash -c "sudo reboot"`, 'sudo'],
    [`echo x | xargs sudo rm`, 'sudo'],
    [`/usr/bin/sudo -i`, 'sudo'],
    [`$(sudo whoami)`, 'sudo'],
    [`systemctl --user status alfred`, null],
  [`systemctl --user list-units --all --no-pager 2>&1 | head -60; which journalctl`, null],
  [`systemctl --user --no-pager list-timers`, null],
  [`systemctl --user restart alfred; systemctl --user status alfred`, 'systemctl'],
  [`systemctl --user stop x`, 'systemctl'],
    [`systemctl restart foo`, 'systemctl'],
    [`ssh baleen uptime`, 'ssh'],
    [`grep -r ssh ~/.config`, null],
    [`find . -name x -exec sudo rm {} \;`, 'sudo'],
    [`time sudo ls`, 'sudo'],
    ['`sudo ls`', 'sudo'],
    [`if true; then reboot; fi`, 'shutdown'],
    [`man shutdown`, null],
  ];
  it.each(cases)('%s → %s', (c, want) => {
    expect(guardCommand(c)).toBe(want);
  });

  it('invokedCommands strips quotes and prefixes; wrappers force conservative matching', () => {
    expect(invokedCommands(`FOO=1 time grep 'sudo' x | wc -l`)).toEqual(['grep', 'wc']);
    expect(invokedCommands(`bash -c 'ls'`)).toBeNull();
  });
});
