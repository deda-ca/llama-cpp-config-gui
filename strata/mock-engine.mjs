// Mock Strata engine: speaks the --serve line protocol so the HTTP/SSE layer in
// strata.ts can be tested without loading the model onto GPUs.
//
//   READY <max_context> stop
//   GEN <max_new> [k=v...] <ids...>   ->  RESUME 0 / REUSED 0 / T <id>... / DONE ...
//   QUIT -> exit
import { createInterface } from 'node:readline';

const rl = createInterface({ input: process.stdin, crlfDelay: Infinity });

process.stdout.write('READY 32768 stop\n');

// A canned reply: "Hello there!" then im_end.
const REPLY = [9419, 1017, 0, 248046];

rl.on('line', (line) => {
  if (line === 'QUIT') {
    process.exit(0);
  }
  if (line.startsWith('GEN ')) {
    const parts = line.split(/\s+/);
    const ids = parts[parts.length - 1].split(',').map(Number);
    process.stdout.write(`RESUME 0\nREUSED 0\n`);
    for (const id of REPLY) process.stdout.write(`T ${id}\n`);
    process.stdout.write(
      `DONE ${REPLY.length} ${ids.length} 12.0 210.5 stop 0 0 0\n`,
    );
  }
});
