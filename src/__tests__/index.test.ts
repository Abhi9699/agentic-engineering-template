import { describe, it, expect } from 'vitest';
import { initializeSystem } from '../index.js';

describe('initializeSystem', () => {
    it('initializes system status with valid timestamp and version', () => {
        const status = initializeSystem();
        expect(status.initialized).toBe(true);
        expect(status.version).toBe('1.0.0');
        expect(typeof status.timestamp).toBe('string');
    });
});
