import { extractArticles } from '../src/llm/parser';

jest.mock('@google/genai', () => {
  return {
    GoogleGenAI: jest.fn().mockImplementation(() => ({
      models: {
        generateContent: jest.fn().mockResolvedValue({
          text: JSON.stringify([
            {
              title: "Mock AI Article",
              summary: "Summary from mock",
              url: "http://mock.com"
            }
          ])
        })
      }
    })),
    Type: { ARRAY: 'ARRAY', OBJECT: 'OBJECT', STRING: 'STRING' }
  };
});

describe('LLM Parser', () => {
  it('should extract articles using the mocked LLM', async () => {
    const result = await extractArticles("Some newsletter text");
    expect(result).toHaveLength(1);
    expect(result[0].title).toBe("Mock AI Article");
    expect(result[0].url).toBe("http://mock.com");
  });
});
