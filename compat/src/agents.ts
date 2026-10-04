/** The agents under test, how each one is started on the cli device, and which scenarios do not apply to it. */

export type AgentId = 'claude' | 'opencode' | 'pi';
export type Scenario = 'roundtrip' | 'tool-allow' | 'tool-deny' | 'abort' | 'kill' | 'blocked-spawn' | 'blocked-shell' | 'offline-start' | 'workstation-resume' | 'resume' | 'spawn';

export type AgentDef = {
    label: string;
    /** Shell command run detached in /workspace on the cli device. */
    start: string;
    /** Scenario → reason it is not applicable. Every entry is backed by evidence in CAPABILITIES.md. */
    unsupported: Partial<Record<Scenario, string>>;
    /** Scenario → `#<n>: <description>` of a documented product bug (CAPABILITIES.md "Bugs found") the cell currently hits. */
    knownBugs?: Partial<Record<Scenario, string>>;
};

const NO_START = 'Removed in the workstation-only build: the app cannot start or resume sessions.';
const NO_ACP_RESUME = '`happycc resume` supports Claude Code and Codex sessions only; ACP sessions cannot be resumed yet (docs/happycc-roadmap.md).';
const NO_PI_PROMPTS = 'Pi has no permission prompts; it runs tools without asking.';

export const AGENTS: Record<AgentId, AgentDef> = {
    claude: {
        label: 'Claude Code',
        start: 'happycc --happy-starting-mode remote',
        unsupported: {
            spawn: NO_START,
            resume: NO_START,
            'offline-start': 'By design: when the server is unreachable at start, happycc runs Claude Code as a local terminal session and only mirrors the transcript after reconnecting; app messages are not accepted in that mode.',
        },
    },
    opencode: {
        label: 'OpenCode',
        start: 'happycc acp opencode',
        unsupported: {
            spawn: NO_START,
            resume: NO_START,
            'workstation-resume': NO_ACP_RESUME,
        },
    },
    pi: {
        label: 'Pi',
        start: 'happycc acp -- pi-acp',
        unsupported: {
            spawn: NO_START,
            resume: NO_START,
            'workstation-resume': NO_ACP_RESUME,
            'tool-allow': NO_PI_PROMPTS,
            'tool-deny': NO_PI_PROMPTS,
        },
    },
};
