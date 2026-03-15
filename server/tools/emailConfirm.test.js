```javascript
import { email_confirm } from '../server/tools/emailConfirm.js';
import { getDraft, clearDraft } from '../server/utils/emailDrafts.js';
import { sendConfirmedEmail } from '../server/tools/email.js';

jest.mock('../server/utils/emailDrafts.js');
jest.mock('../server/tools/email.js');

describe('email_confirm function', () => {
  it('should handle "cancel" action successfully', async () => {
    const sessionId = 'testSession';
    const ctx = { sessionId };
    const request = { context: ctx, action: 'cancel' };
    const clearDraftMock = clearDraft as jest.Mock;
    clearDraftMock.mockResolvedValue(true);

    const result = await email_confirm(request);
    expect(clearDraftMock).toHaveBeenCalledWith(sessionId);
    expect(result).toEqual({
      tool: 'email_confirm',
      success: true,
      final: true,
      data: { message: 'Email draft canceled.' },
    });
  });

  it('should handle "cancel" action with no draft', async () => {
    const sessionId = 'testSession';
    const ctx = { sessionId };
    const request = { context: ctx, action: 'cancel' };
    const clearDraftMock = clearDraft as jest.Mock;
    clearDraftMock.mockResolvedValue(false);

    const result = await email_confirm(request);
    expect(clearDraftMock).toHaveBeenCalledWith(sessionId);
    expect(result).toEqual({
      tool: 'email_confirm',
      success: true,
      final: true,
      data: { message: 'No draft to cancel.' },
    });
  });

  it('should handle "send_confirmed" action successfully', async () => {
    const sessionId = 'testSession';
    const ctx = { sessionId };
    const request = { context: ctx, action: 'send_confirmed' };
    const draft = { to: 'test@example.com', subject: 'Test Subject', body: 'Test Body', attachments: [] };
    const getDraftMock = getDraft as jest.Mock;
    getDraftMock.mockResolvedValue(draft);
    const sendConfirmedEmailMock = sendConfirmedEmail as jest.Mock;
    sendConfirmedEmailMock.mockResolvedValue({ success: true, error: null });

    const result = await email_confirm(request);
    expect(getDraftMock).toHaveBeenCalledWith(sessionId);
    expect(sendConfirmedEmailMock).toHaveBeenCalledWith(draft);
    expect(clearDraft).toHaveBeenCalledWith(sessionId);
    expect(result).toEqual({
      tool: 'email_confirm',
      success: true,
      final: true,
      data: { message: '✅ Email sent to test@example.com', result: { success: true, error: null } },
    });
  });

  it('should handle "send_confirmed" action with missing recipient', async () => {
    const sessionId = 'testSession';
    const ctx = { sessionId };
    const request = { context: ctx, action: 'send_confirmed' };
    const draft = { to: '', subject: 'Test Subject', body: 'Test Body', attachments: [] };
    const getDraftMock = getDraft as jest.Mock;
    getDraftMock.mockResolvedValue(draft);

    const result = await email_confirm(request);
    expect(getDraftMock).toHaveBeenCalledWith(sessionId);
    expect(result).toEqual({
      tool: 'email_confirm',
      success: false,
      final: true,
      error: 'Draft is missing recipient address. Please create a new email draft.',
    });
  });

  it('should handle "send_confirmed" action with no draft', async () => {
    const sessionId = 'testSession';
    const ctx = { sessionId };
    const request = { context: ctx, action: 'send_confirmed' };
    const getDraftMock = getDraft as jest.Mock;
    getDraftMock.mockRejectedValue(new Error('No draft found'));

    const result = await email_confirm(request);
    expect(getDraftMock).toHaveBeenCalledWith(sessionId);
    expect(result).toEqual({
      tool: 'email_confirm',
      success: false,
      final: true,
      error: 'Error fetching draft: No draft found',
    });
  });

  it('should handle unknown action', async () => {
    const sessionId = 'testSession';
    const ctx = { sessionId };
    const request = { context: ctx, action: 'unknown_action' };

    const result = await email_confirm(request);
    expect(result).toEqual({
      tool: 'email_confirm',
      success: false,
      final: true,
      error: 'Unknown action: "unknown_action". Expected "send_confirmed" or "cancel".',
    });
  });

  it('should handle unexpected error', async () => {
    const sessionId = 'testSession';
    const ctx = { sessionId };
    const request = { context: ctx, action: 'send_confirmed' };
    const getDraftMock = getDraft as jest.Mock;
    getDraftMock.mockRejectedValue(new Error('Unexpected error'));

    const result = await email_confirm(request);
    expect(getDraftMock).toHaveBeenCalledWith(sessionId);
    expect(result).toEqual({
      tool: 'email_confirm',
      success: false,
      final: true,
      error: 'Unexpected error',
    });
  });
});
```