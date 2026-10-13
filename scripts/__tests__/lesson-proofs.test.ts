import { describe, it, expect } from 'vitest';
import { isSecretPath } from '../guard-secrets.mjs';

describe('Anti-Regression Proofs (vault/_Lessons.md)', () => {
    it('L-001: guard-secrets identifies staged .env credentials', () => {
        expect(isSecretPath('.env')).toBe(true);
        expect(isSecretPath('.env.local')).toBe(true);
        expect(isSecretPath('service_account.json')).toBe(true);
        expect(isSecretPath('.env.example')).toBe(false);
    });
});
