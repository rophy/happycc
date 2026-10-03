/** The agents under test, how each one is started on the cli device, and which scenarios do not apply to it. */

export type AgentId = 'claude' | 'opencode' | 'pi';
export type Scenario = 'roundtrip' | 'tool-allow' | 'tool-deny' | 'abort' | 'kill' | 'offline-start' | 'resume' | 'spawn';

export type AgentDef = {
    label: string;
    /** Shell command run detached in /workspace on the cli device. */
    start: string;
    /** Scenario → reason it is not applicable. Every entry is backed by evidence in CAPABILITIES.md. */
    unsupported: Partial<Record<Scenario, string>>;
    /** Scenario → `#<n>: <description>` of a documented product bug (CAPABILITIES.md "Bugs found") the cell currently hits. */
    knownBugs?: Partial<Record<Scenario, string>>;
};

const NO_ACP_SPAWN = 'The daemon cannot spawn ACP agents yet.';
const NO_PI_PROMPTS = 'Pi has no permission prompts; it runs tools without asking.';

const BUG_STOP = '#3: `happycc-agent stop` leaves the runner process running';
const BUG_ACP_ABORT = '#4: aborting mid-reply crashes the ACP runner';

export const AGENTS: Record<AgentId, AgentDef> = {
    claude: {
        label: 'Claude Code',
        start: 'happycc --happy-starting-mode remote',
        unsupported: {
            'offline-start': 'By design: when the server is unreachable at start, happycc runs Claude Code as a local terminal session and only mirrors the transcript after reconnecting; app messages are not accepted in that mode.',
        },
        knownBugs: {
            roundtrip: '#1: the first turn of a session never gets turn-end',
            'tool-deny': '#2: denying a permission leaves the turn open',
            kill: BUG_STOP,
        },
    },
    opencode: {
        label: 'OpenCode',
        start: 'happycc acp opencode',
        unsupported: {
            spawn: NO_ACP_SPAWN,
            resume: `The daemon cannot resume ACP sessions (resume fails: uses unsupported flavor "opencode").`,
        },
        knownBugs: { abort: BUG_ACP_ABORT, kill: BUG_STOP },
    },
    pi: {
        label: 'Pi',
        start: 'happycc acp -- pi-acp',
        unsupported: {
            spawn: NO_ACP_SPAWN,
            resume: `The daemon cannot resume ACP sessions (resume fails: uses unsupported flavor "acp").`,
            'tool-allow': NO_PI_PROMPTS,
            'tool-deny': NO_PI_PROMPTS,
        },
        knownBugs: { abort: BUG_ACP_ABORT, kill: BUG_STOP },
    },
};
