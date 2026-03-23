```javascript
import { describe, it, expect } from 'vitest';
import * as documentQA from '../server/tools/documentQA.js';

describe('documentQA', () => {
  // Mock dependencies
  const fsMock = {
    existsSync: vi.fn(),
    readFileSync: vi.fn()
  };
  const addDocumentMock = vi.fn();
  const searchMock = vi.fn();
  const createCollectionMock = vi.fn();
  const listCollectionsMock = vi.fn();
  const getCollectionStatsMock = vi.fn();
  const llmMock = vi.fn();

  beforeAll(() => {
    vi.mock('fs', () => ({
      ...fsMock
    }));
    vi.mock('../utils/vectorStore.js', () => ({
      addDocument: addDocumentMock,
      search: searchMock,
      createCollection: createCollectionMock,
      listCollections: listCollectionsMock,
      getCollectionStats: getCollectionStatsMock
    }));
    vi.mock('./llm.js', () => ({
      llm: llmMock
    }));
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe('loadFile', () => {
    it('should load a .txt file', async () => {
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue('Sample text');

      const result = documentQA.loadFile('/path/to/file.txt');
      expect(result).toBe('Sample text');
    });

    it('should strip HTML tags from .html files', async () => {
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue('<div>Sample <b>text</b></div>');

      const result = documentQA.loadFile('/path/to/file.html');
      expect(result).toBe('Sample text');
    });

    it('should return CSV as-is', async () => {
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue('col1,col2\nvalue1,value2');

      const result = documentQA.loadFile('/path/to/file.csv');
      expect(result).toBe('col1,col2\nvalue1,value2');
    });

    it('should throw error if file not found', async () => {
      fsMock.existsSync.mockReturnValue(false);

      expect(() => documentQA.loadFile('/path/to/file.txt')).toThrowError('File not found: /path/to/file.txt');
    });
  });

  describe('detectDocQAIntent', () => {
    it('should detect ingest intent', async () => {
      const result = documentQA.detectDocQAIntent('load a document');
      expect(result).toBe('ingest');
    });

    it('should detect list intent', async () => {
      const result = documentQA.detectDocQAIntent('list my documents');
      expect(result).toBe('list');
    });

    it('should detect delete intent', async () => {
      const result = documentQA.detectDocQAIntent('delete the collection');
      expect(result).toBe('delete');
    });

    it('should default to ask intent', async () => {
      const result = documentQA.detectDocQAIntent('What is AI?');
      expect(result).toBe('ask');
    });
  });

  describe('extractFilePath', () => {
    it('should extract absolute path', async () => {
      const result = documentQA.extractFilePath('C:/path/to/file.txt');
      expect(result).toBe('C:/path/to/file.txt');
    });

    it('should extract relative path with extension', async () => {
      const result = documentQA.extractFilePath('./relative/path/to/file.txt');
      expect(result).toBe('./relative/path/to/file.txt');
    });

    it('should return null if no file path found', async () => {
      const result = documentQA.extractFilePath('What is AI?');
      expect(result).toBe(null);
    });
  });

  describe('extractCollectionName', () => {
    it('should extract collection name from query', async () => {
      const result = documentQA.extractCollectionName('in collection X');
      expect(result).toBe('X');
    });

    it('should default to "default" if no collection specified', async () => {
      const result = documentQA.extractCollectionName('What is AI?');
      expect(result).toBe('default');
    });
  });

  describe('ingestDocument', () => {
    it('should ingest a document successfully', async () => {
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue('Sample text');
      addDocumentMock.mockResolvedValue({ chunks: 1, docId: 'abc123' });

      const result = await documentQA.ingestDocument('load document /path/to/file.txt');
      expect(result).toEqual({
        tool: 'documentQA',
        success: true,
        final: true,
        data: {
          preformatted: true,
          text: 'Document ingested successfully!\n\n- **File**: file.txt\n- **Collection**: default\n- **Chunks**: 1\n- **Document ID**: abc123\n\nYou can now ask questions about this document.'
        }
      });
    });

    it('should handle error during ingestion', async () => {
      fsMock.existsSync.mockReturnValue(true);
      fsMock.readFileSync.mockReturnValue('Sample text');
      addDocumentMock.mockRejectedValue(new Error('Error adding document'));

      const result = await documentQA.ingestDocument('load document /path/to/file.txt');
      expect(result).toEqual({
        tool: 'documentQA',
        success: false,
        error: 'Failed to ingest document: Error adding document'
      });
    });

    it('should handle invalid file path', async () => {
      fsMock.existsSync.mockReturnValue(false);

      const result = await documentQA.ingestDocument('load document /path/to/file.txt');
      expect(result).toEqual({
        tool: 'documentQA',
        success: false,
        error: 'Please provide a file path to ingest. Example: \'load document D:/docs/report.txt\''
      });
    });
  });

  describe('answerQuestion', () => {
    it('should answer a question successfully', async () => {
      searchMock.mockResolvedValue([{ score: 0.9, text: 'Sample context' }]);
      llmMock.mockResolvedValue({ data: { text: 'Sample answer' } });

      const result = await documentQA.answerQuestion('What is AI?');
      expect(result).toEqual({
        tool: 'documentQA',
        success: true,
        final: true,
        data: {
          text: 'Sample answer',
          sources: [{ filename: undefined, score: 0.9, excerpt: 'Sample context...' }]
        }
      });
    });

    it('should handle error during answer generation', async () => {
      searchMock.mockResolvedValue([{ score: 0.9, text: 'Sample context' }]);
      llmMock.mockRejectedValue(new Error('Error generating answer'));

      const result = await documentQA.answerQuestion('What is AI?');
      expect(result).toEqual({
        tool: 'documentQA',
        success: false,
        error: 'Answer generation failed: Error generating answer'
      });
    });

    it('should handle no relevant results', async () => {
      searchMock.mockResolvedValue([]);

      const result = await documentQA.answerQuestion('What is AI?');
      expect(result).toEqual({
        tool: 'documentQA',
        success: true,
        final: true,
        data: {
          text: 'I found some documents but none seem relevant to your question. Try rephrasing or specifying which document to search in.'
        }
      });
    });
  });

  describe('listDocuments', () => {
    it('should list collections and stats successfully', async () => {
      createCollectionMock.mockResolvedValue({ name: 'default' });
      getCollectionStatsMock.mockResolvedValue({ uniqueDocuments: 1, documentCount: 2 });

      const result = await documentQA.listDocuments();
      expect(result).toEqual({
        tool: 'documentQA',
        success: true,
        final: true,
        data: {
          preformatted: true,
          text: '## Document Collections\n| Collection | Documents | Last Updated |\n|-----------|-----------|-------------|\n| default | 1 docs (2 chunks) | N/A |\n'
        },
        collections: [{ name: 'default', lastUpdated: null }]
      });
    });

    it('should handle no collections found', async () => {
      createCollectionMock.mockResolvedValue(null);

      const result = await documentQA.listDocuments();
      expect(result).toEqual({
        tool: 'documentQA',
        success: true,
        final: true,
        data: {
          preformatted: true,
          text: 'No document collections found. Use \'load document [file path]\' to ingest documents.'
        }
      });
    });
  });

  describe('documentQA', () => {
    it('should handle intent detection and call appropriate handler', async () => {
      documentQA.detectDocQAIntent = vi.fn(() => 'ingest');
      documentQA.ingestDocument = vi.fn();

      await documentQA.documentQA('load document /path/to/file.txt');
      expect(documentQA.detectDocQAIntent).toHaveBeenCalledWith('load document /path/to/file.txt');
      expect(documentQA.ingestDocument).toHaveBeenCalledWith('load document /path/to/file.txt');

      documentQA.detectDocQAIntent.mockReturnValue('ask');
      documentQA.answerQuestion = vi.fn();

      await documentQA.documentQA('What is AI?');
      expect(documentQA.detectDocQAIntent).toHaveBeenCalledWith('What is AI?');
      expect(documentQA.answerQuestion).toHaveBeenCalledWith('What is AI?');

      documentQA.detectDocQAIntent.mockReturnValue('list');
      documentQA.listDocuments = vi.fn();

      await documentQA.documentQA('list my documents');
      expect(documentQA.detectDocQAIntent).toHaveBeenCalledWith('list my documents');
      expect(documentQA.listDocuments).toHaveBeenCalled();
    });

    it('should handle null inputs', async () => {
      const result = await documentQA.documentQA(null);
      expect(result).toEqual({
        tool: 'documentQA',
        success: false,
        error: 'Please provide a file path to ingest. Example: \'load document D:/docs/report.txt\''
      });
    });

    it('should handle empty strings', async () => {
      const result = await documentQA.documentQA('');
      expect(result).toEqual({
        tool: 'documentQA',
        success: false,
        error: 'Please provide a file path to ingest. Example: \'load document D:/docs/report.txt\''
      });
    });
  });
});
```