```javascript
// server/tools/whatsapp.test.js
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as whatsappModule from './whatsapp.js'; // The module under test
import axios from 'axios';
import * as XLSX from 'xlsx';
import fs from 'fs';
import path from 'path';

// Mock dependencies
const mockProjectRoot = '/mock/project/root';
vi.mock('../utils/config.js', () => ({
  PROJECT_ROOT: mockProjectRoot,
}));

// Mock whatsappState for getConversationWindow
vi.mock('../utils/whatsappState.js', () => ({
  getConversationWindow: vi.fn(),
}));

// Mock axios
vi.mock('axios');

// Mock XLSX
vi.mock('xlsx', async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    readFile: vi.fn(),
    utils: {
      sheet_to_json: vi.fn(),
    },
  };
});

// Mock fs
vi.mock('fs', () => ({
  existsSync: vi.fn(),
  readFileSync: vi.fn(),
  writeFileSync: vi.fn(),
}));

// Mock path for resolve (simplifies testing by avoiding actual path operations)
vi.mock('path', async (importOriginal) => {
  const actualPath = await importOriginal();
  return {
    ...actualPath,
    // Custom mock for path.resolve to handle PROJECT_ROOT and safe directory paths
    resolve: vi.fn((...args) => {
      if (args[0] === mockProjectRoot) {
        if (args[1] === 'data' && args[2] === 'pending_whatsapp.json') {
          return `${mockProjectRoot}/data/pending_whatsapp.json`;
        }
        if (args[1] === 'uploads' || args[1] === 'downloads') {
          return `${mockProjectRoot}/${args[1]}/${args[2]}`;
        }
      }
      // Default to actual resolve for other cases or simplify as needed for tests
      return actualPath.resolve(...args);
    }),
    relative: vi.fn(actualPath.relative), // Keep actual relative behavior
    isAbsolute: vi.fn(actualPath.isAbsolute), // Keep actual isAbsolute behavior
    basename: vi.fn(actualPath.basename), // Keep actual basename behavior
  };
});


// Mock dynamic imports
const mockUserProfiles = {
  getAllProfiles: vi.fn(),
  getUserByPhone: vi.fn(),
};
vi.mock('../utils/userProfiles.js', async () => mockUserProfiles);

const mockKnowledge = {
  getRelevantKnowledge: vi.fn(),
};
vi.mock('../knowledge.js', async () => mockKnowledge);

const mockPersonality = {
  getPersonalitySummary: vi.fn(),
};
vi.mock('../personality.js', async () => mockPersonality);

const mockLlm = {
  llm: vi.fn(),
  pickModelForContent: vi.fn(),
};
vi.mock('../tools/llm.js', async () => mockLlm);


// Store original process.env
const originalEnv = process.env;

// Helper to set up common environment variables
const setupEnv = (token = 'TEST_TOKEN', phoneId = 'TEST_PHONE_ID', templateName = 'hello_world', templateLang = 'en_US') => {
  process.env = {
    ...originalEnv,
    WHATSAPP_TOKEN: token,
    WHATSAPP_PHONE_ID: phoneId,
    WHATSAPP_TEMPLATE_NAME: templateName,
    WHATSAPP_TEMPLATE_LANG: templateLang,
  };
};

describe('whatsapp.js', () => {
  beforeEach(() => {
    vi.clearAllMocks(); // Clears mock call history
    vi.restoreAllMocks(); // Restores original implementations if spyOn was used without mock
    setupEnv(); // Reset env for each test

    // Default mock implementations for common dependencies
    axios.post.mockResolvedValue({ data: { messages: [{ id: 'msg_id_123' }] } });
    whatsappModule.getConversationWindow.mockReturnValue({ open: true, remainingMs: 86400000 }); // Default: window open
    
    // Default dynamic imports mock
    vi.mocked(mockUserProfiles.getAllProfiles).mockResolvedValue({
        "972501112222": { name: "Owner", role: "owner", relation: null },
        "972503334444": { name: "Shirly", relation: null },
        "972505556666": { name: "Mom", relation: "mother" },
        "972507778888": { name: "Avram", nameHe: "אברהם", relation: "father" },
    });
    vi.mocked(mockUserProfiles.getUserByPhone).mockImplementation((phone) => {
      const profiles = {
        "972501112222": { name: "Owner", role: "owner", relation: null, language: "en" },
        "972503334444": { name: "Shirly", relation: null, language: "en" },
        "972505556666": { name: "Mom", relation: "mother", language: "he" },
        "972507778888": { name: "Avram", nameHe: "אברהם", relation: "father", language: "he" },
      };
      return Promise.resolve(profiles[phone]);
    });
    vi.mocked(mockLlm.llm).mockResolvedValue({ data: { text: 'Mock generated message.' } });
    vi.mocked(mockLlm.pickModelForContent).mockReturnValue('default-model');
    vi.mocked(mockKnowledge.getRelevantKnowledge).mockResolvedValue('');
    vi.mocked(mockPersonality.getPersonalitySummary).mockResolvedValue('I am a helpful AI assistant.');

    // Mock setTimeout for rate limiting and follow-up delays
    vi.useFakeTimers();
  });

  afterEach(() => {
    // Restore process.env
    process.env = originalEnv;
    vi.useRealTimers();
  });

  // --- stashPendingMessage ---
  describe('stashPendingMessage', () => {
    it('should create a new file and stash message if file does not exist', async () => {
      fs.existsSync.mockReturnValue(false);
      fs.writeFileSync.mockImplementation(() => {});
      fs.readFileSync.mockReturnValue('{}'); // Ensure initial read doesn't fail

      const phone = '123456789';
      const text = 'Hello world';
      await whatsappModule.stashPendingMessage(phone, text);

      expect(fs.existsSync).toHaveBeenCalledWith(`${mockProjectRoot}/data/pending_whatsapp.json`);
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        `${mockProjectRoot}/data/pending_whatsapp.json`,
        expect.stringContaining(`"${phone}": [\n    {\n      "text": "Hello world"`)
      );
    });

    it('should add message to existing phone number array', async () => {
      const existingData = {
        '123456789': [{ text: 'Old message', timestamp: '2023-01-01T00:00:00.000Z' }],
      };
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify(existingData));
      fs.writeFileSync.mockImplementation(() => {});

      const phone = '123456789';
      const text = 'New message';
      await whatsappModule.stashPendingMessage(phone, text);

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        `${mockProjectRoot}/data/pending_whatsapp.json`,
        expect.stringContaining(`"${phone}": [\n    {\n      "text": "Old message"`),
        expect.stringContaining(`\n    {\n      "text": "New message"`)
      );
    });

    it('should add message to a new phone number in existing data', async () => {
      const existingData = {
        '987654321': [{ text: 'Other message', timestamp: '2023-01-01T00:00:00.000Z' }],
      };
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify(existingData));
      fs.writeFileSync.mockImplementation(() => {});

      const phone = '123456789';
      const text = 'Hello world';
      await whatsappModule.stashPendingMessage(phone, text);

      expect(fs.writeFileSync).toHaveBeenCalledWith(
        `${mockProjectRoot}/data/pending_whatsapp.json`,
        expect.stringContaining(`"${phone}": [\n    {\n      "text": "Hello world"`)
      );
      expect(fs.writeFileSync).toHaveBeenCalledWith(
        `${mockProjectRoot}/data/pending_whatsapp.json`,
        expect.stringContaining(`"987654321": [\n    {\n      "text": "Other message"`)
      );
    });

    it('should not stash duplicate identical messages for the same phone', async () => {
      const existingData = {
        '123456789': [{ text: 'Hello world', timestamp: '2023-01-01T00:00:00.000Z' }],
      };
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockReturnValue(JSON.stringify(existingData));
      fs.writeFileSync.mockImplementation(() => {});

      const phone = '123456789';
      const text = 'Hello world';
      await whatsappModule.stashPendingMessage(phone, text);

      expect(fs.writeFileSync).not.toHaveBeenCalled();
    });

    it('should handle file read errors gracefully', async () => {
      fs.existsSync.mockReturnValue(true);
      fs.readFileSync.mockImplementation(() => { throw new Error('File read error'); });
      fs.writeFileSync.mockImplementation(() => {}); // Should not be called if read fails

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const phone = '123456789';
      const text = 'Hello world';
      await whatsappModule.stashPendingMessage(phone, text);

      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to stash message'), expect.any(Error));
      expect(fs.writeFileSync).not.toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });
  });

  // --- cleanPhoneNumber ---
  describe('cleanPhoneNumber', () => {
    it('should return null for null or undefined input', () => {
      expect(whatsappModule.cleanPhoneNumber(null)).toBeNull();
      expect(whatsappModule.cleanPhoneNumber(undefined)).toBeNull();
    });

    it('should return null for empty string or non-numeric input', () => {
      expect(whatsappModule.cleanPhoneNumber('')).toBeNull();
      expect(whatsappModule.cleanPhoneNumber('abc')).toBeNull();
      expect(whatsappModule.cleanPhoneNumber('000')).toBeNull(); // Too short
    });

    it('should strip non-digit characters', () => {
      expect(whatsappModule.cleanPhoneNumber('+1 (555) 123-4567')).toBe('15551234567');
      expect(whatsappModule.cleanPhoneNumber('054-123-4567')).toBe('972541234567'); // Israeli number conversion
      expect(whatsappModule.cleanPhoneNumber('(054) 123 4567')).toBe('972541234567');
    });

    it('should normalize Israeli mobile numbers starting with 05', () => {
      expect(whatsappModule.cleanPhoneNumber('0541234567')).toBe('972541234567');
      expect(whatsappModule.cleanPhoneNumber('0501234567')).toBe('972501234567');
    });

    it('should normalize other Israeli numbers starting with 0', () => {
      expect(whatsappModule.cleanPhoneNumber('021234567')).toBe('97221234567'); // 9 digits
      expect(whatsappModule.cleanPhoneNumber('0312345678')).toBe('972312345678'); // 10 digits
    });

    it('should return null if number is too short after cleaning', () => {
      expect(whatsappModule.cleanPhoneNumber('123456789')).toBeNull(); // 9 digits, min 10
    });

    it('should return null if number is too long after cleaning', () => {
      expect(whatsappModule.cleanPhoneNumber('1234567890123456')).toBeNull(); // 16 digits, max 15
    });

    it('should return the number if already clean and valid', () => {
      expect(whatsappModule.cleanPhoneNumber('972541234567')).toBe('972541234567');
      expect(whatsappModule.cleanPhoneNumber('1234567890')).toBe('1234567890');
    });
  });

  // --- resolveContact ---
  describe('resolveContact', () => {
    beforeEach(() => {
      vi.mocked(mockUserProfiles.getAllProfiles).mockResolvedValue({
        "972501112222": { name: "Owner", role: "owner", relation: null, language: "en" },
        "972503334444": { name: "Shirly", relation: null, language: "en" },
        "972505556666": { name: "Mom", relation: "mother", language: "he" },
        "972507778888": { name: "Avram", nameHe: "אברהם", relation: "father", language: "he" },
        "972509990000": { name: "My Wife", relation: "wife", language: "en" },
        "972501012020": { name: "Amir", nameHe: "אמיר", relation: null, language: "he" },
        "_placeholder": { name: "Placeholder", relation: null }, // Should be skipped
      });
    });

    it('should return null for null or empty input', async () => {
      expect(await whatsappModule.resolveContact(null)).toBeNull();
      expect(await whatsappModule.resolveContact('')).toBeNull();
    });

    it('should resolve "me" or "myself" to the owner\'s phone', async () => {
      expect(await whatsappModule.resolveContact('me')).toBe('972501112222');
      expect(await whatsappModule.resolveContact('myself')).toBe('972501112222');
      expect(await whatsappModule.resolveContact('עצמי')).toBe('972501112222');
      expect(await whatsappModule.resolveContact('to myself')).toBe('972501112222');
    });

    it('should resolve by direct name match', async () => {
      expect(await whatsappModule.resolveContact('Shirly')).toBe('972503334444');
      expect(await whatsappModule.resolveContact('shirly')).toBe('972503334444');
      expect(await whatsappModule.resolveContact('Amir')).toBe('972501012020');
      expect(await whatsappModule.resolveContact('אמיר')).toBe('972501012020');
    });

    it('should resolve by direct relation match', async () => {
      expect(await whatsappModule.resolveContact('mother')).toBe('972505556666');
      expect(await whatsappModule.resolveContact('father')).toBe('972507778888');
    });

    it('should resolve by relation aliases', async () => {
      expect(await whatsappModule.resolveContact('mom')).toBe('972505556666');
      expect(await whatsappModule.resolveContact('my mom')).toBe('972505556666');
      expect(await whatsappModule.resolveContact('אמא שלי')).toBe('972505556666');
      expect(await whatsappModule.resolveContact('wife')).toBe('972509990000');
    });

    it('should return null if contact is not found', async () => {
      expect(await whatsappModule.resolveContact('nonexistent')).toBeNull();
      expect(await whatsappModule.resolveContact('friend')).toBeNull(); // No 'friend' relation in mock data
    });

    it('should skip placeholder profiles', async () => {
      expect(await whatsappModule.resolveContact('_placeholder')).toBeNull();
    });

    it('should handle errors from getAllProfiles gracefully', async () => {
      vi.mocked(mockUserProfiles.getAllProfiles).mockRejectedValue(new Error('DB error'));
      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      expect(await whatsappModule.resolveContact('Shirly')).toBeNull();
      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('Contact resolution failed'), expect.stringContaining('DB error'));
      consoleWarnSpy.mockRestore();
    });
  });

  // --- isCompositionInstruction ---
  describe('isCompositionInstruction', () => {
    it('should return true for composition instruction phrases', () => {
      expect(whatsappModule.isCompositionInstruction('write a message')).toBe(true);
      expect(whatsappModule.isCompositionInstruction('compose a welcoming message')).toBe(true);
      expect(whatsappModule.isCompositionInstruction('draft a short text')).toBe(true);
      expect(whatsappModule.isCompositionInstruction('the message should be funny')).toBe(true);
      expect(whatsappModule.isCompositionInstruction('make it professional')).toBe(true);
      expect(whatsappModule.isCompositionInstruction('a cynical message')).toBe(true);
      expect(whatsappModule.isCompositionInstruction('generate a brief note')).toBe(true);
      expect(whatsappModule.isCompositionInstruction('with a touch of warmth')).toBe(true);
      expect(whatsappModule.isCompositionInstruction('הודעה מצחיקה')).toBe(true);
      expect(whatsappModule.isCompositionInstruction('הודעה ציניקנית')).toBe(true);
      expect(whatsappModule.isCompositionInstruction('an extremely long message should be')).toBe(true);
      expect(whatsappModule.isCompositionInstruction('a nice message for my mom')).toBe(true);
    });

    it('should return false for literal message text', () => {
      expect(whatsappModule.isCompositionInstruction('Hello there!')).toBe(false);
      expect(whatsappModule.isCompositionInstruction('Hi, how are you?')).toBe(false);
      expect(whatsappModule.isCompositionInstruction('See you at 5pm')).toBe(false);
      expect(whatsappModule.isCompositionInstruction('תודה רבה')).toBe(false);
    });

    it('should return false for null or empty input', () => {
      expect(whatsappModule.isCompositionInstruction(null)).toBe(false);
      expect(whatsappModule.isCompositionInstruction('')).toBe(false);
    });
  });

  // --- detectWhatsAppIntent ---
  describe('detectWhatsAppIntent', () => {
    // Note: resolveContact and isCompositionInstruction are used directly here,
    // so their mocks from higher up will apply.

    it('should detect self-send intent', async () => {
      const result = await whatsappModule.detectWhatsAppIntent('send me a whatsapp saying hello');
      expect(result).toEqual({
        intent: 'single_send',
        to: '972501112222', // Mocked owner phone
        message: 'hello',
        filename: null,
        isComposeRequest: false,
        recipientName: 'myself'
      });
      const result2 = await whatsappModule.detectWhatsAppIntent('שלח לי הודעה אומרת היי');
      expect(result2.to).toBe('972501112222');
      expect(result2.message).toBe('היי');
    });

    it('should detect self-send intent with implied message', async () => {
      const result = await whatsappModule.detectWhatsAppIntent('send me a whatsapp');
      expect(result.to).toBe('972501112222');
      expect(result.message).toBe('Hi!');
      expect(result.isComposeRequest).toBe(false); // Default "Hi!" is not a compose instruction
    });


    it('should detect bulk_send intent with "everyone in contacts.xlsx saying..."', async () => {
      const result = await whatsappModule.detectWhatsAppIntent('send whatsapp to everyone in contacts.xlsx saying hello world');
      expect(result).toEqual({
        intent: 'bulk_send',
        filename: 'contacts.xlsx',
        message: 'hello world',
        to: null,
      });
    });

    it('should detect bulk_send intent with "bulk contacts.xlsx: message"', async () => {
      const result = await whatsappModule.detectWhatsAppIntent('bulk whatsapp numbers.xlsx: important update');
      expect(result).toEqual({
        intent: 'bulk_send',
        filename: 'numbers.xlsx',
        message: 'important update',
        to: null,
      });
    });

    it('should detect single_send to resolved contact by name (pattern 1)', async () => {
      const result = await whatsappModule.detectWhatsAppIntent('send a message to Shirly saying hi');
      expect(result).toEqual({
        intent: 'single_send',
        to: '972503334444',
        message: 'hi',
        filename: null,
        isComposeRequest: false,
        recipientName: 'Shirly'
      });
    });

    it('should detect single_send to resolved contact by name (pattern 1 with compose instruction)', async () => {
      const result = await whatsappModule.detectWhatsAppIntent('send a message to Shirly, the message should be warm and funny');
      expect(result).toEqual({
        intent: 'single_send',
        to: '972503334444',
        message: 'warm and funny',
        filename: null,
        isComposeRequest: true,
        recipientName: 'Shirly'
      });
    });

    it('should detect single_send to resolved contact by relation (pattern 1 with compose instruction)', async () => {
      const result = await whatsappModule.detectWhatsAppIntent('send a message to my mom, make it short');
      expect(result).toEqual({
        intent: 'single_send',
        to: '972505556666',
        message: 'make it short',
        filename: null,
        isComposeRequest: true,
        recipientName: 'mom'
      });
    });

    it('should detect single_send to resolved contact by name (pattern 2 with adj message)', async () => {
      const result = await whatsappModule.detectWhatsAppIntent('send Shirly a funny message');
      expect(result).toEqual({
        intent: 'single_send',
        to: '972503334444',
        message: 'funny message', // The regex grabs more than intended here, but compose mode fixes it
        filename: null,
        isComposeRequest: true,
        recipientName: 'Shirly'
      });
    });

    it('should detect single_send with explicit phone number', async () => {
      const result = await whatsappModule.detectWhatsAppIntent('send a whatsapp to 054-123-4567 saying hello');
      expect(result).toEqual({
        intent: 'single_send',
        to: '054-123-4567',
        message: 'hello',
        filename: null,
        isComposeRequest: false,
      });
    });

    it('should detect simple whatsapp to phone number', async () => {
      const result = await whatsappModule.detectWhatsAppIntent('whatsapp +972541234567 hey there');
      expect(result).toEqual({
        intent: 'single_send',
        to: '+972541234567',
        message: 'hey there',
        filename: null,
        isComposeRequest: false,
      });
    });

    it('should detect "send message to PHONE saying MSG"', async () => {
      const result = await whatsappModule.detectWhatsAppIntent('send message to 0541234567 saying hi');
      expect(result).toEqual({
        intent: 'single_send',
        to: '0541234567',
        message: 'hi',
        filename: null,
        isComposeRequest: false,
      });
    });

    it('should detect "send to NAME" with implied compose', async () => {
      const result = await whatsappModule.detectWhatsAppIntent('send a whatsapp to Avram, a warm message');
      expect(result).toEqual({
        intent: 'single_send',
        to: '972507778888',
        message: 'a warm message',
        filename: null,
        isComposeRequest: true,
        recipientName: 'Avram'
      });
    });

    it('should detect "send NAME message saying MSG"', async () => {
      const result = await whatsappModule.detectWhatsAppIntent('send Shirly a message saying hi');
      expect(result).toEqual({
        intent: 'single_send',
        to: '972503334444',
        message: 'hi',
        filename: null,
        isComposeRequest: false,
        recipientName: 'Shirly'
      });
    });

    it('should detect "send PHONE MSG"', async () => {
      const result = await whatsappModule.detectWhatsAppIntent('send 0541234567 hi there');
      expect(result).toEqual({
        intent: 'single_send',
        to: '0541234567',
        message: 'hi there',
        filename: null,
        isComposeRequest: false,
      });
    });

    it('should detect "send whatsapp to PHONE" as compose request', async () => {
      const result = await whatsappModule.detectWhatsAppIntent('send a whatsapp to 0541234567');
      expect(result).toEqual({
        intent: 'single_send',
        to: '0541234567',
        message: 'Compose a natural, conversational message to check in. Do not sound like a generic bot.',
        filename: null,
        isComposeRequest: true,
      });
    });

    it('should detect "send whatsapp to PHONE from yourself" as compose request with hint', async () => {
      const result = await whatsappModule.detectWhatsAppIntent('send a whatsapp to 0541234567 from yourself');
      expect(result).toEqual({
        intent: 'single_send',
        to: '0541234567',
        message: 'Compose a natural, conversational message to check in. Do not sound like a generic bot.',
        filename: null,
        isComposeRequest: true,
      });
    });

    it('should detect "send whatsapp to PHONE a birthday greeting" as compose request with hint', async () => {
      const result = await whatsappModule.detectWhatsAppIntent('send a whatsapp to 0541234567 a birthday greeting');
      expect(result).toEqual({
        intent: 'single_send',
        to: '0541234567',
        message: 'Compose a message: a birthday greeting',
        filename: null,
        isComposeRequest: true,
      });
    });

    it('should return unknown for unparseable input', async () => {
      const result = await whatsappModule.detectWhatsAppIntent('just say hi');
      expect(result).toEqual({
        intent: 'unknown',
        to: null,
        message: null,
        filename: null,
      });
    });

    it('should handle errors during parsing', async () => {
      // Force resolveContact to throw for this test
      vi.mocked(mockUserProfiles.getAllProfiles).mockRejectedValue(new Error('Mock profile error'));
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await whatsappModule.detectWhatsAppIntent('send a message to Shirly saying hi');
      expect(result.intent).toBe('error');
      expect(result.error).toBe('Mock profile error');
      expect(consoleErrorSpy).toHaveBeenCalled();
      consoleErrorSpy.mockRestore();
    });
  });

  // --- sendTemplateMessage ---
  describe('sendTemplateMessage', () => {
    const internalSendTemplateMessage = whatsappModule.sendTemplateMessage; // Access the internal function

    it('should send a template message successfully with the first valid attempt (named var)', async () => {
      setupEnv('TOKEN', 'PHONE_ID', 'my_template');
      axios.post.mockResolvedValueOnce({ data: { messages: [{ id: 'template_msg_id' }] } });

      const result = await internalSendTemplateMessage('972501234567', 'some text');
      expect(result.success).toBe(true);
      expect(result.messageId).toBe('template_msg_id');
      expect(result.to).toBe('972501234567');
      expect(axios.post).toHaveBeenCalledTimes(1);
      expect(axios.post).toHaveBeenCalledWith(
        'https://graph.facebook.com/v18.0/PHONE_ID/messages',
        expect.objectContaining({
          template: {
            name: 'my_template',
            language: { code: 'he' },
            components: [
              {
                type: 'body',
                parameters: [
                  { type: 'text', parameter_name: 'updater_name', text: 'מערכת לנו' }
                ]
              }
            ]
          }
        }),
        expect.any(Object)
      );
    });

    it('should fallback to hello_world if custom template fails (template error)', async () => {
      setupEnv('TOKEN', 'PHONE_ID', 'my_template');
      axios.post
        .mockRejectedValueOnce({ response: { data: { error: { code: 132000, message: 'Template param mismatch' } } } }) // Attempt 1: Named var, fails
        .mockRejectedValueOnce({ response: { data: { error: { code: 132001, message: 'Template not found' } } } }) // Attempt 2: No params, fails
        .mockRejectedValueOnce({ response: { data: { error: { code: 132005, message: 'Template not active' } } } }) // Attempt 3: Minimalist, fails
        .mockResolvedValueOnce({ data: { messages: [{ id: 'hello_world_id' }] } }); // Attempt 4: hello_world, succeeds

      const result = await internalSendTemplateMessage('972501234567', 'some text');
      expect(result.success).toBe(true);
      expect(result.messageId).toBe('hello_world_id');
      expect(result.usedTemplate).toBe('hello_world');
      expect(axios.post).toHaveBeenCalledTimes(4); // 4 attempts were made
      expect(axios.post).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({
          template: { name: 'hello_world', language: { code: 'en_US' } }
        }),
        expect.any(Object)
      );
    });

    it('should not retry if a non-template error occurs', async () => {
      setupEnv('TOKEN', 'PHONE_ID', 'my_template');
      axios.post.mockRejectedValueOnce({ response: { data: { error: { code: 100, message: 'Auth error' } } } }); // Non-template error

      const result = await internalSendTemplateMessage('972501234567', 'some text');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Auth error');
      expect(axios.post).toHaveBeenCalledTimes(1);
    });

    it('should return failure if all attempts fail', async () => {
      setupEnv('TOKEN', 'PHONE_ID', 'my_template');
      axios.post
        .mockRejectedValueOnce({ response: { data: { error: { code: 132000, message: 'Param mismatch' } } } })
        .mockRejectedValueOnce({ response: { data: { error: { code: 132001, message: 'Template not found' } } } })
        .mockRejectedValueOnce({ response: { data: { error: { code: 132005, message: 'Another template error' } } } })
        .mockRejectedValueOnce({ response: { data: { error: { code: 132005, message: 'Final template error' } } } });


      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const result = await internalSendTemplateMessage('972501234567', 'some text');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Final template error');
      expect(axios.post).toHaveBeenCalledTimes(4);
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('All template attempts failed'), expect.stringContaining('Final template error'));
      consoleErrorSpy.mockRestore();
    });
  });

  // --- sendWhatsAppMessage ---
  describe('sendWhatsAppMessage', () => {
    // We'll spy on the internal sendTemplateMessage for this, and mock cleanPhoneNumber.
    const cleanPhoneNumberSpy = vi.spyOn(whatsappModule, 'cleanPhoneNumber');
    const sendTemplateMessageSpy = vi.spyOn(whatsappModule, 'sendTemplateMessage');
    const stashPendingMessageSpy = vi.spyOn(whatsappModule, 'stashPendingMessage');

    beforeEach(() => {
      cleanPhoneNumberSpy.mockReturnValue('972501234567');
      sendTemplateMessageSpy.mockResolvedValue({ success: true, to: '972501234567', messageId: 'template_id', usedTemplate: 'my_template' });
      stashPendingMessageSpy.mockResolvedValue(undefined);
    });

    it('should return error for invalid phone number', async () => {
      cleanPhoneNumberSpy.mockReturnValue(null);
      const result = await whatsappModule.sendWhatsAppMessage('invalid-phone', 'Hello');
      expect(result).toEqual({ success: false, to: 'invalid-phone', error: 'Invalid phone number: "invalid-phone"' });
      expect(cleanPhoneNumberSpy).toHaveBeenCalledWith('invalid-phone');
      expect(axios.post).not.toHaveBeenCalled();
    });

    it('should send freeform message if conversation window is open', async () => {
      whatsappModule.getConversationWindow.mockReturnValue({ open: true, remainingMs: 3600000 }); // Open
      axios.post.mockResolvedValueOnce({ data: { messages: [{ id: 'freeform_id' }] } });

      const result = await whatsappModule.sendWhatsAppMessage('0541234567', 'Test message');
      expect(result.success).toBe(true);
      expect(result.messageId).toBe('freeform_id');
      expect(axios.post).toHaveBeenCalledTimes(1);
      expect(axios.post).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ type: 'text', text: { body: 'Test message' } }),
        expect.any(Object)
      );
      expect(sendTemplateMessageSpy).not.toHaveBeenCalled();
    });

    it('should use template if conversation window is closed', async () => {
      whatsappModule.getConversationWindow.mockReturnValue({ open: false, remainingMs: 0 }); // Closed
      sendTemplateMessageSpy.mockResolvedValueOnce({ success: true, to: '972501234567', messageId: 'template_id', usedTemplate: 'hello_world' });
      axios.post.mockResolvedValueOnce({ data: { messages: [{ id: 'follow_up_id' }] } }); // For follow-up text

      const result = await whatsappModule.sendWhatsAppMessage('0541234567', 'Test message');
      expect(result.success).toBe(true);
      expect(result.messageId).toBe('follow_up_id');
      expect(sendTemplateMessageSpy).toHaveBeenCalledTimes(1);
      expect(sendTemplateMessageSpy).toHaveBeenCalledWith('972501234567', 'Test message');
      expect(axios.post).toHaveBeenCalledTimes(1); // One for follow up text
      expect(result.note).toBe('Sent via template + follow-up');

      vi.advanceTimersByTime(1500); // Advance timer for setTimeout
      expect(axios.post).toHaveBeenCalledTimes(1); // Already checked
    });

    it('should use template if forceTemplate option is true, even if window is open', async () => {
      whatsappModule.getConversationWindow.mockReturnValue({ open: true, remainingMs: 3600000 }); // Open
      sendTemplateMessageSpy.mockResolvedValueOnce({ success: true, to: '972501234567', messageId: 'template_id', usedTemplate: 'hello_world' });
      axios.post.mockResolvedValueOnce({ data: { messages: [{ id: 'follow_up_id' }] } }); // For follow-up text

      const result = await whatsappModule.sendWhatsAppMessage('0541234567', 'Test message', { forceTemplate: true });
      expect(result.success).toBe(true);
      expect(result.messageId).toBe('follow_up_id');
      expect(sendTemplateMessageSpy).toHaveBeenCalledTimes(1);
      expect(sendTemplateMessageSpy).toHaveBeenCalledWith('972501234567', 'Test message');
      expect(axios.post).toHaveBeenCalledTimes(1);
      expect(result.note).toBe('Sent via template + follow-up');
    });

    it('should skip window check if skipWindowCheck is true (always send freeform)', async () => {
      whatsappModule.getConversationWindow.mockReturnValue({ open: false, remainingMs: 0 }); // Closed
      axios.post.mockResolvedValueOnce({ data: { messages: [{ id: 'freeform_id' }] } });

      const result = await whatsappModule.sendWhatsAppMessage('0541234567', 'Test message', { skipWindowCheck: true });
      expect(result.success).toBe(true);
      expect(result.messageId).toBe('freeform_id');
      expect(axios.post).toHaveBeenCalledTimes(1);
      expect(sendTemplateMessageSpy).not.toHaveBeenCalled();
    });

    it('should return error if template send fails when window is closed', async () => {
      whatsappModule.getConversationWindow.mockReturnValue({ open: false, remainingMs: 0 }); // Closed
      sendTemplateMessageSpy.mockResolvedValueOnce({ success: false, to: '972501234567', error: 'Template failed', usedTemplate: 'my_template' });

      const result = await whatsappModule.sendWhatsAppMessage('0541234567', 'Test message');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Cannot reach 972501234567: no active conversation window');
      expect(result.error).toContain('template "my_template" failed: Template failed');
      expect(sendTemplateMessageSpy).toHaveBeenCalledTimes(1);
      expect(axios.post).not.toHaveBeenCalled(); // No freeform attempt
    });

    it('should send template and stash message if follow-up text fails (no real window)', async () => {
      whatsappModule.getConversationWindow.mockReturnValue({ open: false, remainingMs: 0 }); // Closed
      sendTemplateMessageSpy.mockResolvedValueOnce({ success: true, to: '972501234567', messageId: 'template_id', usedTemplate: 'hello_world' });
      axios.post.mockRejectedValueOnce(new Error('Follow-up failed due to no window')); // Simulate follow-up text failure

      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await whatsappModule.sendWhatsAppMessage('0541234567', 'Test message');
      expect(result.success).toBe(true); // Template still succeeded
      expect(result.messageId).toBe('template_id');
      expect(result.note).toContain('Template "hello_world" sent, but follow-up message could not be delivered.');
      expect(sendTemplateMessageSpy).toHaveBeenCalledTimes(1);
      expect(axios.post).toHaveBeenCalledTimes(1); // One for follow-up
      expect(stashPendingMessageSpy).toHaveBeenCalledWith('972501234567', 'Test message');
      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('Follow-up text failed (expected if no real window)'));
      consoleWarnSpy.mockRestore();
    });

    it('should retry with template if freeform message fails due to window expiry', async () => {
      whatsappModule.getConversationWindow.mockReturnValue({ open: true, remainingMs: 3600000 }); // Open initially
      axios.post
        .mockRejectedValueOnce({ response: { data: { error: { code: 131047, message: 'Conversation window expired' } } } }) // Freeform fails
        .mockResolvedValueOnce({ data: { messages: [{ id: 'template_id_retry' }] } }); // Template succeeds on retry

      sendTemplateMessageSpy.mockResolvedValueOnce({ success: true, to: '972501234567', messageId: 'template_id_retry', usedTemplate: 'my_template' });
      // If template is sent, no follow-up text will be attempted in this path (it's handled by sendTemplateMessage's return)

      const consoleWarnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const result = await whatsappModule.sendWhatsAppMessage('0541234567', 'Test message');
      expect(result.success).toBe(true);
      expect(result.messageId).toBe('template_id_retry');
      expect(axios.post).toHaveBeenCalledTimes(1); // For the initial freeform attempt
      expect(sendTemplateMessageSpy).toHaveBeenCalledTimes(1); // For the retry attempt
      expect(consoleWarnSpy).toHaveBeenCalledWith(expect.stringContaining('Window expired mid-send for 972501234567, retrying with template'));
      consoleWarnSpy.mockRestore();
    });

    it('should return error if freeform message fails for other reasons', async () => {
      whatsappModule.getConversationWindow.mockReturnValue({ open: true, remainingMs: 3600000 }); // Open
      axios.post.mockRejectedValueOnce({ response: { data: { error: { code: 999, message: 'Other API error' } } } });

      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
      const result = await whatsappModule.sendWhatsAppMessage('0541234567', 'Test message');
      expect(result.success).toBe(false);
      expect(result.error).toBe('Other API error');
      expect(axios.post).toHaveBeenCalledTimes(1);
      expect(sendTemplateMessageSpy).not.toHaveBeenCalled();
      expect(consoleErrorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to send to 972501234567'), 'Other API error');
      consoleErrorSpy.mockRestore();
    });
  });

  // --- resolveFilePath ---
  describe('resolveFilePath', () => {
    const internalResolveFilePath = whatsappModule.resolveFilePath; // Access internal function
    beforeEach(() => {
      fs.existsSync.mockReturnValue(false); // Default to not found
      // path.relative and path.isAbsolute are using actual implementations.
    });

    it('should return null for sensitive filenames', () => {
      expect(internalResolveFilePath('credentials.env')).toBeNull();
      expect(internalResolveFilePath('config.js')).toBeNull();
      expect(internalResolveFilePath('my.key')).toBeNull();
      expect(internalResolveFilePath('service_account.json')).toBeNull();
      expect(internalResolveFilePath('.env')).toBeNull();
    });

    it('should resolve existing file in uploads directory', () => {
      fs.existsSync.mockImplementation((p) => p === `${mockProjectRoot}/uploads/my_file.xlsx`);
      expect(internalResolveFilePath('my_file.xlsx')).toBe(`${mockProjectRoot}/uploads/my_file.xlsx`);
    });

    it('should resolve existing file in downloads directory', () => {
      fs.existsSync.mockImplementation((p) => p === `${mockProjectRoot}/downloads/report.csv`);
      expect(internalResolveFilePath('report.csv')).toBe(`${mockProjectRoot}/downloads/report.csv`);
    });

    it('should return null if file does not exist in safe directories', () => {
      fs.existsSync.mockReturnValue(false); // Make sure it doesn't exist
      expect(internalResolveFilePath('non_existent.txt')).toBeNull();
    });

    it('should return null for path traversal attempts', () => {
      fs.existsSync.mockReturnValue(true); // Pretend file exists
      // Mock path.relative to simulate traversal
      path.relative.mockImplementationOnce((from, to) => `../sensitive/file.txt`); // Simulate traversal for first path check
      path.relative.mockImplementationOnce((from, to) => `../sensitive/file.txt`); // Simulate traversal for second path check

      expect(internalResolveFilePath('../sensitive/file.txt')).toBeNull();
      expect(internalResolveFilePath('/etc/passwd')).toBeNull(); // path.isAbsolute(rel) for /etc/passwd
      expect(internalResolveFilePath('uploads/../sensitive.txt')).toBeNull(); // relative check should catch this too
    });

    it('should prioritize uploads over downloads if both contain a file', () => {
      // In this setup, it iterates through SAFE_DIRS. The first one found takes precedence.
      fs.existsSync.mockImplementation((p) => {
        return p === `${mockProjectRoot}/uploads/file.txt` || p === `${mockProjectRoot}/downloads/file.txt`;
      });
      expect(internalResolveFilePath('file.txt')).toBe(`${mockProjectRoot}/uploads/file.txt`);
    });
  });

  // --- processBulkExcelSend ---
  describe('processBulkExcelSend', () => {
    const internalProcessBulkExcelSend = whatsappModule.processBulkExcelSend; // Access internal function
    const resolveFilePathSpy = vi.spyOn(whatsappModule, 'resolveFilePath');
    const sendWhatsAppMessageSpy = vi.spyOn(whatsappModule, 'sendWhatsAppMessage');

    beforeEach(() => {
      resolveFilePathSpy.mockReturnValue(`${mockProjectRoot}/uploads/contacts.xlsx`);
      vi.mocked(XLSX.readFile).mockReturnValue({
        SheetNames: ['Sheet1'],
        Sheets: {
          Sheet1: {},
        },
      });
      vi.mocked(XLSX.utils.sheet_to_json).mockReturnValue([
        { Name: 'John Doe', Phone: '0541112233' },
        { Name: 'Jane Smith', Phone: '0544445566' },
        { Name: 'Invalid No', Phone: 'not-a-number' },
        { Name: 'No Phone', Phone: null },
      ]);
      sendWhatsAppMessageSpy.mockResolvedValue({ success: true, to: '972541112233', messageId: 'msg1' });
      // Mock setTimeout for the rate limit
      vi.spyOn(global, 'setTimeout').mockImplementation((fn) => fn()); // Execute immediately
    });

    afterEach(() => {
      vi.restoreAllMocks(); // Restore original setTimeout
    });

    it('should return error if file path cannot be resolved', async () => {
      resolveFilePathSpy.mockReturnValue(null);
      const result = await internalProcessBulkExcelSend('non_existent.xlsx', 'Hello');
      expect(result.success).toBe(false);
      expect(result.error).toContain('File not found');
      expect(XLSX.readFile).not.toHaveBeenCalled();
    });

    it('should return error if Excel file read fails', async () => {
      vi.mocked(XLSX.readFile).mockImplementation(() => { throw new Error('Bad Excel'); });
      const result = await internalProcessBulkExcelSend('contacts.xlsx', 'Hello');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Failed to read Excel file: Bad Excel');
      expect(XLSX.readFile).toHaveBeenCalled();
    });

    it('should return error if Excel file is empty', async () => {
      vi.mocked(XLSX.utils.sheet_to_json).mockReturnValue([]);
      const result = await internalProcessBulkExcelSend('contacts.xlsx', 'Hello');
      expect(result.success).toBe(false);
      expect(result.error).toContain('Excel file is empty or has no data rows.');
    });

    it('should return error if no phone column is found', async () => {
      vi.mocked(XLSX.utils.sheet_to_json).mockReturnValue([
        { Name: 'John Doe', Email: 'john@example.com' },
      ]);
      const result = await internalProcessBulkExcelSend('contacts.xlsx', 'Hello');
      expect(result.success).toBe(false);
      expect(result.error).toContain('No phone column found');
      expect(result.error).toContain('Expected one of: phone, phone number, phonenumber');
      expect(result.error).toContain('Found columns: Name, Email');
    });

    it('should successfully send messages to valid phone numbers', async () => {
      sendWhatsAppMessageSpy
        .mockResolvedValueOnce({ success: true, to: '972541112233', messageId: 'msg1' })
        .mockResolvedValueOnce({ success: true, to: '972544445566', messageId: 'msg2' })
        .mockResolvedValueOnce({ success: false, to: 'not-a-number', error: 'Invalid phone' }); // Third one fails clean phone
      
      vi.spyOn(whatsappModule, 'cleanPhoneNumber').mockImplementation((num) => {
        if (num === '0541112233') return '972541112233';
        if (num === '0544445566') return '972544445566';
        return null;
      });

      const result = await internalProcessBulkExcelSend('contacts.xlsx', 'Hello from bulk');
      expect(result.success).toBe(true);
      expect(result.sent).toBe(2);
      expect(result.failed).toBe(2); // 'not-a-number' and 'null'
      expect(result.total).toBe(4);
      expect(sendWhatsAppMessageSpy).toHaveBeenCalledTimes(4); // Even if cleanPhoneNumber returns null, sendWhatsAppMessage is called
      expect(sendWhatsAppMessageSpy).toHaveBeenCalledWith('0541112233', 'Hello from bulk');
      expect(sendWhatsAppMessageSpy).toHaveBeenCalledWith('0544445566', 'Hello from bulk');
      expect(result.errors.length).toBe(1); // Only for 'not-a-number' as null isn't an error message from sendWhatsAppMessage
      expect(result.errors[0]).toContain('not-a-number: Invalid phone');
    });

    it('should identify phone column using Hebrew names', async () => {
      vi.mocked(XLSX.utils.sheet_to_json).mockReturnValue([
        { Name: 'שלמה', 'מספר טלפון': '0541112233' },
      ]);
      sendWhatsAppMessageSpy.mockResolvedValue({ success: true, to: '972541112233', messageId: 'msg1' });
      vi.spyOn(whatsappModule, 'cleanPhoneNumber').mockReturnValue('972541112233');

      const result = await internalProcessBulkExcelSend('contacts.xlsx', 'Hello from bulk');
      expect(result.success).toBe(true);
      expect(result.sent).toBe(1);
      expect(result.failed).toBe(0);
      expect(sendWhatsAppMessageSpy).toHaveBeenCalledWith('0541112233', 'Hello from bulk');
    });
  });

  // --- whatsapp (main tool entry point) ---
  describe('whatsapp tool', () => {
    // We'll spy on detectWhatsAppIntent, sendWhatsAppMessage, processBulkExcelSend here
    const detectWhatsAppIntentSpy = vi.spyOn(whatsappModule, 'detectWhatsAppIntent');
    const sendWhatsAppMessageSpy = vi.spyOn(whatsappModule, 'sendWhatsAppMessage');
    const processBulkExcelSendSpy = vi.spyOn(whatsappModule, 'processBulkExcelSend');

    beforeEach(() => {
      setupEnv('TEST_TOKEN', 'TEST_PHONE_ID');
      detectWhatsAppIntentSpy.mockResolvedValue({ intent: 'unknown' }); // Default to unknown
      sendWhatsAppMessageSpy.mockResolvedValue({ success: true, to: '972501234567', messageId: 'tool_msg_id' });
      processBulkExcelSendSpy.mockResolvedValue({ success: true, sent: 1, failed: 0, total: 1, errors: [] });
    });

    it('should return error if WhatsApp env vars are not set', async () => {
      process.env.WHATSAPP_TOKEN = '';
      process.env.WHATSAPP_PHONE_ID = '';
      const result = await whatsappModule.whatsapp('hello');
      expect(result.success).toBe(false);
      expect(result.final).toBe(true);
      expect(result.error).toContain('WhatsApp is not configured');
    });

    it('should return error for empty input text', async () => {
      const result = await whatsappModule.whatsapp('');
      expect(result.success).toBe(false);
      expect(result.final).toBe(true);
      expect(result.error).toContain('Please describe what to send');
    });

    it('should handle single_send intent (happy path)', async () => {
      detectWhatsAppIntentSpy.mockResolvedValueOnce({
        intent: 'single_send',
        to: '0541234567',
        message: 'Hello!',
        filename: null,
        isComposeRequest: false,
      });
      const result = await whatsappModule.whatsapp('send a whatsapp to 0541234567 saying Hello!');
      expect(result.success).toBe(true);
      expect(result.final).toBe(true);
      expect(result.data.text).toContain('✅ Sent WhatsApp to 0541234567 (972541234567)');
      expect(result.data.text).toContain('📝 Message: "Hello!"');
      expect(sendWhatsAppMessageSpy).toHaveBeenCalledWith('0541234567', 'Hello!');
    });

    it('should handle single_send intent with compose request', async () => {
      detectWhatsAppIntentSpy.mockResolvedValueOnce({
        intent: 'single_send',
        to: '0541234567',
        message: 'a funny message',
        filename: null,
        isComposeRequest: true,
        recipientName: 'Shirly'
      });
      vi.mocked(mockLlm.llm).mockResolvedValueOnce({ data: { text: 'Haha, here is your funny message!' } });

      const result = await whatsappModule.whatsapp('send Shirly a funny message');
      expect(result.success).toBe(true);
      expect(result.final).toBe(true);
      expect(result.data.text).toContain('✅ Sent WhatsApp to Shirly (972503334444)');
      expect(result.data.text).toContain('📝 Message: "Haha, here is your funny message!"');
      expect(sendWhatsAppMessageSpy).toHaveBeenCalledWith('972503334444', 'Haha, here is your funny message!');
      expect(mockLlm.llm).toHaveBeenCalled();
      expect(mockUserProfiles.getUserByPhone).toHaveBeenCalledWith('972503334444');
      expect(mockPersonality.getPersonalitySummary).toHaveBeenCalled();
    });

    it('should include knowledge context in compose prompt if requested', async () => {
      detectWhatsAppIntentSpy.mockResolvedValueOnce({
        intent: 'single_send',
        to: '0541234567',
        message: 'tell me about the recent news',
        filename: null,
        isComposeRequest: true,
        recipientName: 'Shirly'
      });
      vi.mocked(mockLlm.llm).mockResolvedValueOnce({ data: { text: 'Here is the news!' } });
      vi.mocked(mockKnowledge.getRelevantKnowledge).mockResolvedValueOnce('Mocked knowledge about news.');

      await whatsappModule.whatsapp('send Shirly a whatsapp about the recent news');

      expect(mockKnowledge.getRelevantKnowledge).toHaveBeenCalledWith(expect.stringContaining('about the recent news'));
      expect(mockLlm.llm).toHaveBeenCalledWith(
        expect.stringContaining('BACKGROUND KNOWLEDGE:\nMocked knowledge about news.'),
        expect.any(Object)
      );
    });

    it('should include sender context in compose prompt (as self)', async () => {
      detectWhatsAppIntentSpy.mockResolvedValueOnce({
        intent: 'single_send',
        to: '0541234567',
        message: 'send a message as yourself',
        filename: null,
        isComposeRequest: true,
        recipientName: 'Shirly'
      });
      vi.mocked(mockLlm.llm).mockResolvedValueOnce({ data: { text: 'Hello, I am a helpful AI assistant...' } });

      await whatsappModule.whatsapp('send Shirly a message as yourself');

      expect(mockLlm.llm).toHaveBeenCalledWith(
        expect.stringContaining('You are writing AS YOURSELF (the AI agent). Your identity: I am a helpful AI assistant.'),
        expect.any(Object)
      );
      expect(mockLlm.llm).toHaveBeenCalledWith(
        expect.stringContaining('🚨 CRITICAL: You already know this person and have spoken before. DO NOT introduce yourself (no "Hi, I\'m Lanou").'),
        expect.any(Object)
      );
    });

    it('should handle bulk_send intent (happy path)', async () => {
      detectWhatsAppIntentSpy.mockResolvedValueOnce({
        intent: 'bulk_send',
        filename: 'contacts.xlsx',
        message: 'Event reminder',
        to: null,
      });
      processBulkExcelSendSpy.mockResolvedValueOnce({ success: true, sent: 10, failed: 2, total: 12, errors: ['error1', 'error2'] });

      const result = await whatsappModule.whatsapp('bulk whatsapp contacts.xlsx: Event reminder');
      expect(result.success).toBe(true);
      expect(result.final).toBe(true);
      expect(result.data.text).toContain('📊 **Bulk WhatsApp Send Complete**');
      expect(result.data.sent).toBe(10);
      expect(result.data.failed).toBe(2);
      expect(result.data.total).toBe(12);
      expect(processBulkExcelSendSpy).toHaveBeenCalledWith('contacts.xlsx', 'Event reminder');
    });

    it('should handle bulk_send intent failure', async () => {
      detectWhatsAppIntentSpy.mockResolvedValueOnce({
        intent: 'bulk_send',
        filename: 'contacts.xlsx',
        message: 'Event reminder',
        to: null,
      });
      processBulkExcelSendSpy.mockResolvedValueOnce({ success: false, error: 'File not found' });

      const result = await whatsappModule.whatsapp('bulk whatsapp contacts.xlsx: Event reminder');
      expect(result.success).toBe(false);
      expect(result.final).toBe(true);
      expect(result.error).toContain('File not found');
    });


    it('should handle chain context (news)', async () => {
      const newsHtml = `<div class="news-card"><span class="news-source">Source A</span><h3 class="news-summary-title">Headline 1</h3></div><div class="news-card"><span class="news-source">Source B</span><h3 class="news-summary-title">Headline 2</h3></div>`;
      const request = {
        text: 'send news to 0541234567',
        context: {
          useLastResult: true,
          chainContext: {
            previousOutput: newsHtml,
            previousTool: 'news',
            previousRaw: {}
          },
          recipient: '0541234567'
        }
      };
      
      const sendWhatsAppMessageRealSpy = vi.spyOn(whatsappModule, 'sendWhatsAppMessage');
      sendWhatsAppMessageRealSpy.mockResolvedValue({ success: true, to: '972541234567', messageId: 'chain_news_id' });
      vi.spyOn(whatsappModule, 'cleanPhoneNumber').mockReturnValue('972541234567');

      const result = await whatsappModule.whatsapp(request);
      expect(result.success).toBe(true);
      expect(result.data.text).toContain('✅ Sent news results via WhatsApp to 972541234567');
      expect(sendWhatsAppMessageRealSpy).toHaveBeenCalledWith(
        '0541234567',
        expect.stringContaining('*Latest News*\n\n• [Source A] Headline 1\n• [Source B] Headline 2')
      );
    });

    it('should handle chain context (weather - raw data)', async () => {
      const weatherRaw = { city: 'Tel Aviv', temp: 25, feels_like: 26, description: 'clear sky', wind_speed: 5, humidity: 70 };
      const request = {
        text: 'send weather to my mom',
        context: {
          useChainContext: true,
          chainContext: {
            previousOutput: 'The weather in Tel Aviv is 25°C...',
            previousTool: 'weather',
            previousRaw: weatherRaw
          },
          recipient: '972505556666' // Mom's number
        }
      };
      
      const sendWhatsAppMessageRealSpy = vi.spyOn(whatsappModule, 'sendWhatsAppMessage');
      sendWhatsAppMessageRealSpy.mockResolvedValue({ success: true, to: '972505556666', messageId: 'chain_weather_id' });
      vi.spyOn(whatsappModule, 'cleanPhoneNumber').mockReturnValue('972505556666');

      const result = await whatsappModule.whatsapp(request);
      expect(result.success).toBe(true);
      expect(sendWhatsAppMessageRealSpy).toHaveBeenCalledWith(
        '972505556666',
        expect.stringContaining('🌤️ *Weather Report*\n📍 Tel Aviv\n🌡️ 25°C (feels like 26°C)\n☁️ clear sky\n💨 Wind: 5 m/s\n💧 Humidity: 70%')
      );
    });

    it('should handle chain context (weather - HTML parsing fallback)', async () => {
      const weatherHtml = `The weather in Tel Aviv is <span>25.5°C</span>. Feels like: <span>26.1°C</span>. Conditions: cloudy. Wind: 5.2 m/s. Humidity: 70%.`;
      const request = {
        text: 'send weather to my mom',
        context: {
          useChainContext: true,
          chainContext: {
            previousOutput: weatherHtml,
            previousTool: 'weather',
            previousRaw: null // No raw data
          },
          recipient: '972505556666' // Mom's number
        }
      };
      
      const sendWhatsAppMessageRealSpy = vi.spyOn(whatsappModule, 'sendWhatsAppMessage');
      sendWhatsAppMessageRealSpy.mockResolvedValue({ success: true, to: '972505556666', messageId: 'chain_weather_id' });
      vi.spyOn(whatsappModule, 'cleanPhoneNumber').mockReturnValue('972505556666');

      const result = await whatsappModule.whatsapp(request);
      expect(result.success).toBe(true);
      expect(sendWhatsAppMessageRealSpy).toHaveBeenCalledWith(
        '972505556666',
        expect.stringContaining('🌤️ *Weather Report*\n🌡️ 25.5°C (feels like 26.1°C)\n☁️ cloudy\n💨 Wind: 5.2 m/s\n💧 Humidity: 70%')
      );
    });

    it('should handle chain context (X/Twitter - raw plain text)', async () => {
      const xRaw = { plain: 'Check out this tweet: https://x.com/someuser/status/123456' };
      const request = {
        text: 'send latest tweet to my mom',
        context: {
          useChainContext: true,
          chainContext: {
            previousOutput: '<div>...html...</div>',
            previousTool: 'x',
            previousRaw: xRaw
          },
          recipient: '972505556666' // Mom's number
        }
      };
      
      const sendWhatsAppMessageRealSpy = vi.spyOn(whatsappModule, 'sendWhatsAppMessage');
      sendWhatsAppMessageRealSpy.mockResolvedValue({ success: true, to: '972505556666', messageId: 'chain_x_id' });
      vi.spyOn(whatsappModule, 'cleanPhoneNumber').mockReturnValue('972505556666');

      const result = await whatsappModule.whatsapp(request);
      expect(result.success).toBe(true);
      expect(sendWhatsAppMessageRealSpy).toHaveBeenCalledWith(
        '972505556666',
        'Check out this tweet: https://x.com/someuser/status/123456'
      );
    });

    it('should handle chain context (X/Twitter - HTML parsing fallback for trends)', async () => {
      const xHtmlTrends = `
        <div class="x-trend-item">
          <a href="https://x.com/search?q=%23Trend1" class="x-trend-name"><strong>#Trend1</strong></a>
        </div>
        <div class="x-trend-item">
          <a href="https://x.com/search?q=%23Trend2" class="x-trend-name"><strong>#Trend2</strong></a>
        </div>
      `;
      const request = {
        text: 'send trending to 0541234567',
        context: {
          useChainContext: true,
          chainContext: {
            previousOutput: xHtmlTrends,
            previousTool: 'x',
            previousRaw: null // No raw data
          },
          recipient: '0541234567'
        }
      };
      
      const sendWhatsAppMessageRealSpy = vi.spyOn(whatsappModule, 'sendWhatsAppMessage');
      sendWhatsAppMessageRealSpy.mockResolvedValue({ success: true, to: '972541234567', messageId: 'chain_x_trends_id' });
      vi.spyOn(whatsappModule, 'cleanPhoneNumber').mockReturnValue('972541234567');

      const result = await whatsappModule.whatsapp(request);
      expect(result.success).toBe(true);
      expect(sendWhatsAppMessageRealSpy).toHaveBeenCalledWith(
        '0541234567',
        expect.stringContaining('*Trending on X*\n\n1. #Trend1\n🔗 https://x.com/search?q=%23Trend1\n\n2. #Trend2\n🔗 https://x.com/search?q=%23Trend2')
      );
    });

    it('should handle chain context (generic HTML fallback)', async () => {
      const genericHtml = `
        <p>Hello <strong>World</strong>!</p>
        <span style="display:none;">hidden content</span>
        <a href="#">Link</a>
      `;
      const request = {
        text: 'send this to 0541234567',
        context: {
          useChainContext: true,
          chainContext: {
            previousOutput: genericHtml,
            previousTool: 'some_other_tool',
            previousRaw: null
          },
          recipient: '0541234567'
        }
      };

      const sendWhatsAppMessageRealSpy = vi.spyOn(whatsappModule, 'sendWhatsAppMessage');
      sendWhatsAppMessageRealSpy.mockResolvedValue({ success: true, to: '972541234567', messageId: 'chain_generic_id' });
      vi.spyOn(whatsappModule, 'cleanPhoneNumber').mockReturnValue('972541234567');

      const result = await whatsappModule.whatsapp(request);
      expect(result.success).toBe(true);
      expect(sendWhatsAppMessageRealSpy).toHaveBeenCalledWith(
        '0541234567',
        'Hello World! Link' // HTML stripped and whitespace normalized
      );
    });


    it('should truncate long chain context messages', async () => {
      const longMessage = 'a'.repeat(5000);
      const request = {
        text: 'send long message to 0541234567',
        context: {
          useChainContext: true,
          chainContext: {
            previousOutput: longMessage,
            previousTool: 'some_tool',
            previousRaw: null
          },
          recipient: '0541234567'
        }
      };
      
      const sendWhatsAppMessageRealSpy = vi.spyOn(whatsappModule, 'sendWhatsAppMessage');
      sendWhatsAppMessageRealSpy.mockResolvedValue({ success: true, to: '972541234567', messageId: 'chain_long_id' });
      vi.spyOn(whatsappModule, 'cleanPhoneNumber').mockReturnValue('972541234567');

      const result = await whatsappModule.whatsapp(request);
      expect(result.success).toBe(true);
      expect(sendWhatsAppMessageRealSpy).toHaveBeenCalledWith(
        '0541234567',
        expect.stringMatching(new RegExp(`^${'a'.repeat(4000)}\\n\\n\\.\\.\\\\. \\(truncated\\)$`))
      );
    });

    it('should return error if chain context has no recipient', async () => {
      const request = {
        text: 'send results',
        context: {
          useChainContext: true,
          chainContext: {
            previousOutput: 'results',
            previousTool: 'some_tool',
            previousRaw: null
          },
          recipient: null
        }
      };
      const result = await whatsappModule.whatsapp(request);
      expect(result.success).toBe(false);
      expect(result.final).toBe(true);
      expect(result.error).toContain('Chain context: no recipient phone number provided.');
      expect(sendWhatsAppMessageSpy).not.toHaveBeenCalled();
    });

    it('should return error for unhandled intent', async () => {
      detectWhatsAppIntentSpy.mockResolvedValueOnce({ intent: 'unknown' });
      const result = await whatsappModule.whatsapp('some unparseable text');
      expect(result.success).toBe(false);
      expect(result.final).toBe(true);
      expect(result.error).toContain('Could not understand the WhatsApp request');
    });

    it('should return error if tool encounters an unexpected error', async () => {
      detectWhatsAppIntentSpy.mockImplementation(() => { throw new Error('Unexpected tool error'); });
      const consoleErrorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

      const result = await whatsappModule.whatsapp('send hi');
      expect(result.success).toBe(false);
      expect(result.final).toBe(true);
      expect(result.error).toContain('WhatsApp tool error: Unexpected tool error');
      expect(consoleErrorSpy).toHaveBeenCalledWith('❌ [WhatsApp] Tool error:', 'Unexpected tool error');
      consoleErrorSpy.mockRestore();
    });
  });
});
```