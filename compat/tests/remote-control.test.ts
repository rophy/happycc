import { describe } from 'vitest';
import { forEachAgent } from '../src/matrix';

// Resume and spawn were removed in the workstation-only build: every agent has an N/A entry for both
// (`AGENTS[...].unsupported`), so these only register the skipped cells. The boundary is proven by `blocked-spawn`
// in `boundary.test.ts`.
describe('remote-control', () => {
    const removed = async () => {
        throw new Error('resume/spawn are N/A in the workstation-only build and must not run');
    };
    forEachAgent('resume', removed);
    forEachAgent('spawn', removed);
});
