```javascript
import { describe, it, expect } from 'vitest';
import * as emailUtils from '../emailUtils';

describe('emailUtils', () => {
  describe('emailRegex', () => {
    it('should match valid email addresses', () => {
      expect(emailUtils.emailRegex.test('test@example.com')).toBe(true);
      expect(emailUtils.emailRegex.test('john.doe@example.co.uk')).toBe(true);
      expect(emailUtils.emailRegex.test('jane_doe@example.org')).toBe(true);
    });

    it('should not match invalid email addresses', () => {
      expect(emailUtils.emailRegex.test('invalidemail')).toBe(false);
      expect(emailUtils.emailRegex.test('missing@domain')).toBe(false);
      expect(emailUtils.emailRegex.test('noatsign.com')).toBe(false);
    });
  });

  describe('subjectRegex', () => {
    it('should match valid subject lines', () => {
      expect(emailUtils.subjectRegex.test('Subject: Meeting Reminder')).toBe(true);
      expect(emailUtils.subjectRegex.test('subject: Feedback Request')).toBe(true);
      expect(emailUtils.subjectRegex.test('SUBJECT: Project Update')).toBe(true);
    });

    it('should not match invalid subject lines', () => {
      expect(emailUtils.subjectRegex.test('No subject')).toBe(false);
      expect(emailUtils.subjectRegex.test('Subject: ')).toBe(false);
      expect(emailUtils.subjectRegex.test('')).toBe(false);
    });
  });

  describe('sayingRegex', () => {
    it('should match valid saying formats', () => {
      expect(emailUtils.sayingRegex.test('Saying: Have a great day')).toBe(true);
      expect(emailUtils.sayingRegex.test('saying: Best regards')).toBe(true);
      expect(emailUtils.sayingRegex.test('Saying with the planner: Keep it simple')).toBe(true);
    });

    it('should not match invalid saying formats', () => {
      expect(emailUtils.sayingRegex.test('Saying: ')).toBe(false);
      expect(emailUtils.sayingRegex.test('Saying: ')).toBe(false);
      expect(emailUtils.sayingRegex.test('')).toBe(false);
    });
  });

  describe('attachmentPatterns', () => {
    it('should match valid attachment patterns', () => {
      expect(emailUtils.attachmentPatterns.some(pattern => pattern.test('with report.pdf attached'))).toBe(true);
      expect(emailUtils.attachmentPatterns.some(pattern => pattern.test('attach document.docx'))).toBe(true);
      expect(emailUtils.attachmentPatterns.some(pattern => pattern.test('send the presentation.pptx'))).toBe(true);
    });

    it('should not match invalid attachment patterns', () => {
      expect(emailUtils.attachmentPatterns.some(pattern => pattern.test('without attachment'))).toBe(false);
      expect(emailUtils.attachmentPatterns.some(pattern => pattern.test('attach report'))).toBe(false);
      expect(emailUtils.attachmentPatterns.some(pattern => pattern.test('send presentation'))).toBe(false);
    });
  });

  describe('SENTIMENT_KEYWORDS', () => {
    it('should return valid sentiment keywords', () => {
      expect(emailUtils.SENTIMENT_KEYWORDS.includes('happy')).toBe(true);
      expect(emailUtils.SENTIMENT_KEYWORDS.includes('sad')).toBe(true);
      expect(emailUtils.SENTIMENT_KEYWORDS.includes('formal')).toBe(true);
    });

    it('should not include invalid sentiment keywords', () => {
      expect(emailUtils.SENTIMENT_KEYWORDS.includes('invalid')).toBe(false);
      expect(emailUtils.SENTIMENT_KEYWORDS.includes('unknown')).toBe(false);
    });
  });

  describe('stripMarkdown', () => {
    it('should remove markdown characters', () => {
      expect(emailUtils.stripMarkdown('_**~~This is a test~~**_')).toBe('This is a test');
    });

    it('should handle null and empty strings', () => {
      expect(emailUtils.stripMarkdown(null)).toBe('');
      expect(emailUtils.stripMarkdown('')).toBe('');
    });
  });

  describe('detectSentiment', () => {
    it('should detect valid sentiment keywords', () => {
      expect(emailUtils.detectSentiment('This is a happy email')).toBe('happy');
      expect(emailUtils.detectSentiment('make the email formal')).toBe('formal');
      expect(emailUtils.detectSentiment('in a friendly style')).toBe('friendly');
    });

    it('should handle null and empty strings', () => {
      expect(emailUtils.detectSentiment(null)).toBe(null);
      expect(emailUtils.detectSentiment('')).toBe(null);
    });

    it('should return null for no sentiment keywords', () => {
      expect(emailUtils.detectSentiment('No sentiment here')).toBe(null);
    });
  });
});
```