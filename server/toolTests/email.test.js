```javascript
import { describe, it, expect } from 'vitest';
import { generateEmailBody, parseEmailRequest, findAttachment, browseEmails, deleteEmails, buildRawMessage, email, sendConfirmedEmail } from '../server/tools/email.js';
import { google } from 'googleapis';
import { getAuthorizedClient } from '../server/utils/googleOAuth.js';
import { getMemory } from '../server/memory.js';
import { llm } from '../server/tools/llm.js';

vi.mock('googleapis');
vi.mock('../server/utils/googleOAuth.js');
vi.mock('../server/tools/llm.js');
vi.mock('../server/memory.js');
vi.mock('../server/utils/config.js');
vi.mock('../server/tools/contacts.js');
vi.mock('../server/tools/emailUtils.js');

describe('email.js', () => {
  describe('generateEmailBody', () => {
    it('should generate an email body with default values', async () => {
      const result = await generateEmailBody({});
      expect(result).toContain('Hi,\n\nThis is an automatically generated email.\n\nBest regards,\nYour AI agent');
    });

    it('should generate an email body with custom sentiment', async () => {
      const result = await generateEmailBody({ sentiment: 'positive' });
      expect(result).toContain('positive');
    });

    it('should generate an email body with custom word count', async () => {
      const result = await generateEmailBody({ wordCount: 100 });
      expect(result.length).toBe(100);
    });
  });

  describe('parseEmailRequest', () => {
    it('should parse a basic email request', async () => {
      const result = await parseEmailRequest('email to john@example.com with subject "Hello" and body "Hi!"');
      expect(result).toEqual({
        to: 'john@example.com',
        subject: 'Hello',
        body: 'Hi!',
        isHtml: false,
        requestedAttachments: []
      });
    });

    it('should parse a request with HTML flag', async () => {
      const result = await parseEmailRequest('email to john@example.com with subject "Hello" and body "Hi!" as html');
      expect(result.isHtml).toBe(true);
    });

    it('should parse a request with attachments', async () => {
      const result = await parseEmailRequest('email to john@example.com with subject "Hello" and body "Hi!" and attach file1.txt');
      expect(result.requestedAttachments).toEqual(['file1.txt']);
    });
  });

  describe('findAttachment', () => {
    it('should find an attachment in the correct path', async () => {
      vi.mocked(fs.access).mockResolvedValue();
      const result = await findAttachment('file1.txt');
      expect(result).toEqual(path.resolve(PROJECT_ROOT, 'uploads', 'file1.txt'));
    });

    it('should return null if attachment not found', async () => {
      vi.mocked(fs.access).mockRejectedValue(new Error('File not found'));
      const result = await findAttachment('file1.txt');
      expect(result).toBeNull();
    });
  });

  describe('browseEmails', () => {
    it('should browse emails with a query text', async () => {
      vi.mocked(google.gmail.v1.users.messages.list).mockResolvedValue({});
      const result = await browseEmails('inbox');
      expect(result).toEqual(expect.any(Object));
    });

    it('should handle errors during email browsing', async () => {
      vi.mocked(google.gmail.v1.users.messages.list).mockRejectedValue(new Error('Error'));
      const result = await browseEmails('inbox');
      expect(result).toEqual(expect.any(Object));
      expect(result.error).toEqual('Failed to browse emails: Error');
    });
  });

  describe('deleteEmails', () => {
    it('should delete emails with a query text', async () => {
      vi.mocked(google.gmail.v1.users.messages.list).mockResolvedValue({});
      const result = await deleteEmails('inbox');
      expect(result).toEqual(expect.any(Object));
    });

    it('should handle errors during email deletion', async () => {
      vi.mocked(google.gmail.v1.users.messages.list).mockRejectedValue(new Error('Error'));
      const result = await deleteEmails('inbox');
      expect(result).toEqual(expect.any(Object));
      expect(result.error).toEqual('Failed to delete emails: Error');
    });
  });

  describe('buildRawMessage', () => {
    it('should build a raw message without attachments', async () => {
      const result = await buildRawMessage({
        to: 'john@example.com',
        subject: 'Hello',
        body: 'Hi!'
      });
      expect(result).toContain('To: john@example.com');
      expect(result).toContain('Subject: Hello');
      expect(result).toContain('Hi!');
    });

    it('should build a raw message with attachments', async () => {
      const result = await buildRawMessage({
        to: 'john@example.com',
        subject: 'Hello',
        body: 'Hi!',
        attachments: [{ filename: 'file1.txt', filepath: 'path/to/file1.txt', size: 1024 }]
      });
      expect(result).toContain('To: john@example.com');
      expect(result).toContain('Subject: Hello');
      expect(result).toContain('Hi!');
      expect(result).toContain('file1.txt');
    });
  });

  describe('email', () => {
    it('should compose an email draft', async () => {
      const result = await email('email to john@example.com with subject "Hello" and body "Hi!"');
      expect(result).toEqual(expect.any(Object));
      expect(result.data.mode).toEqual('draft');
      expect(result.data.to).toEqual('john@example.com');
      expect(result.data.subject).toEqual('Hello');
      expect(result.data.body).toContain('Hi!');
    });

    it('should handle errors during email composition', async () => {
      vi.mocked(parseEmailRequest).mockRejectedValue(new Error('Error'));
      const result = await email('email to john@example.com with subject "Hello" and body "Hi!"');
      expect(result).toEqual(expect.any(Object));
      expect(result.error).toEqual('Email operation failed: Error');
    });
  });

  describe('sendConfirmedEmail', () => {
    it('should send a confirmed email', async () => {
      const result = await sendConfirmedEmail({
        to: 'john@example.com',
        subject: 'Hello',
        body: 'Hi!'
      });
      expect(result).toEqual(expect.any(Object));
      expect(result.data.message).toEqual('✅ Email sent successfully to john@example.com');
    });

    it('should handle errors during email sending', async () => {
      vi.mocked(google.gmail.v1.users.messages.send).mockRejectedValue(new Error('Error'));
      const result = await sendConfirmedEmail({
        to: 'john@example.com',
        subject: 'Hello',
        body: 'Hi!'
      });
      expect(result).toEqual(expect.any(Object));
      expect(result.error).toEqual('Email sending failed: Error');
    });
  });
});
```