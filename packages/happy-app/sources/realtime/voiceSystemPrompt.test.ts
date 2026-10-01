import { describe, expect, it } from 'vitest';
import { VOICE_FIRST_MESSAGE, VOICE_SYSTEM_PROMPT_BASE, buildVoiceSystemPrompt } from './voiceSystemPrompt';

describe('buildVoiceSystemPrompt', () => {
    it('contains no paid onboarding or upgrade copy', () => {
        const prompt = buildVoiceSystemPrompt({ voiceMessageCount: 3 });
        expect(prompt.startsWith(VOICE_SYSTEM_PROMPT_BASE)).toBe(true);
        expect(prompt).toContain('- voice_message_count: 3');
        expect(prompt).not.toContain('Paid voice onboarding');
        expect(prompt).not.toContain('upgrade');
        expect(prompt).not.toContain('onboarding_prompt_load_count');
    });

    it('appends the conversation history when given', () => {
        const prompt = buildVoiceSystemPrompt({ voiceMessageCount: 0, initialContext: '  user asked for tests  ' });
        expect(prompt.endsWith('# Conversation history so far\nuser asked for tests')).toBe(true);
    });

    it('greets the same way for everyone', () => {
        expect(VOICE_FIRST_MESSAGE).toBe('Hi, Happy here');
    });
});
