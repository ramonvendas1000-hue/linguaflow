import OpenAI from 'openai';
import type { LangCode } from '../../types/index.js';

export interface TranslationResult {
  text: string;
  provider: 'google' | 'openai' | 'mymemory' | 'mock';
  ok: boolean;
  detectedLang?: LangCode;
}

const MYMEMORY_LANG: Record<LangCode, string> = {
  pt: 'pt-BR', en: 'en-GB', es: 'es', fr: 'fr', de: 'de',
  it: 'it', ja: 'ja', zh: 'zh', ru: 'ru', ar: 'ar',
};

// MyMemory returns short lang codes — map back to LangCode
const MYMEMORY_REVERSE: Record<string, LangCode> = {
  pt: 'pt', 'pt-br': 'pt', en: 'en', 'en-gb': 'en', 'en-us': 'en',
  es: 'es', fr: 'fr', de: 'de', it: 'it', ja: 'ja',
  zh: 'zh', 'zh-cn': 'zh', ru: 'ru', ar: 'ar',
};

interface MyMemoryResponse {
  responseStatus: number;
  responseData: { translatedText: string; detectedLanguage?: string };
  matches?: Array<{ translation: string; quality: number }>;
}

async function translateWithMyMemory(
  text: string, from: string, to: string
): Promise<{ text: string; detectedLang?: string } | null> {
  try {
    const langpair = from === 'auto' ? `${to}` : `${from}|${to}`;
    const url = `https://api.mymemory.translated.net/get?q=${encodeURIComponent(text)}&langpair=${encodeURIComponent(langpair)}`;
    const resp = await fetch(url, { signal: AbortSignal.timeout(10_000) });
    if (!resp.ok) return null;
    const data = await resp.json() as MyMemoryResponse;
    if (data.responseStatus !== 200) return null;
    const translated = data.responseData.translatedText?.trim();
    if (!translated || translated === text) return null;
    return { text: translated, detectedLang: data.responseData.detectedLanguage ?? undefined };
  } catch {
    return null;
  }
}

// Google Translate via unofficial web API (may be rate-limited on cloud IPs)
async function translateWithGoogle(text: string, from: string, to: string): Promise<string | null> {
  try {
    const { translate } = await import('@vitalets/google-translate-api');
    const result = await translate(text, {
      from: from === 'auto' ? undefined : from,
      to,
      fetchOptions: { signal: AbortSignal.timeout(8_000) },
    });
    return result.text ?? null;
  } catch {
    return null;
  }
}

function getOpenAIClient(): OpenAI | null {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  return new OpenAI({ apiKey: key });
}

async function translateWithOpenAI(text: string, from: LangCode, to: LangCode): Promise<string | null> {
  const client = getOpenAIClient();
  if (!client) return null;

  const langNames: Record<LangCode, string> = {
    pt: 'Brazilian Portuguese', en: 'English', es: 'Spanish', fr: 'French',
    de: 'German', it: 'Italian', ja: 'Japanese', zh: 'Chinese', ru: 'Russian', ar: 'Arabic',
  };

  try {
    const completion = await client.chat.completions.create({
      model: 'gpt-4o-mini',
      messages: [
        {
          role: 'system',
          content: `Translate from ${langNames[from]} to ${langNames[to]}. Return ONLY the translated text.`,
        },
        { role: 'user', content: text },
      ],
      max_tokens: 500,
    });
    return completion.choices[0]?.message?.content?.trim() ?? null;
  } catch {
    return null;
  }
}

export async function translate(opts: {
  text: string;
  from: LangCode;
  to: LangCode;
}): Promise<TranslationResult> {
  const { text, from, to } = opts;

  if (from === to) {
    return { text, provider: 'mock', ok: true };
  }

  const fromCode = MYMEMORY_LANG[from];
  const toCode   = MYMEMORY_LANG[to];

  // 1. MyMemory (free, reliable on cloud hosts)
  const mm = await translateWithMyMemory(text, fromCode, toCode);
  if (mm?.text) return { text: mm.text, provider: 'mymemory', ok: true };

  // 2. Google Translate (unofficial, may fail on cloud IPs)
  const google = await translateWithGoogle(text, fromCode, toCode);
  if (google) return { text: google, provider: 'google', ok: true };

  // 3. OpenAI (only if key is configured)
  const openai = await translateWithOpenAI(text, from, to);
  if (openai) return { text: openai, provider: 'openai', ok: true };

  // All failed
  console.error(`[translation] All providers failed: ${from}→${to}: "${text.slice(0, 40)}"`);
  return { text, provider: 'mock', ok: false };
}

export async function detectLang(text: string): Promise<LangCode> {
  // Use MyMemory — translate to EN and it returns the detected lang
  try {
    const result = await translateWithMyMemory(text, 'auto', 'en-GB');
    if (result?.detectedLang) {
      const code = result.detectedLang.toLowerCase().split('-')[0];
      return (MYMEMORY_REVERSE[result.detectedLang.toLowerCase()] ?? MYMEMORY_REVERSE[code]) ?? 'en';
    }
  } catch {}

  // Fallback: Google
  try {
    const { translate } = await import('@vitalets/google-translate-api');
    const result = await translate(text, { to: 'en', fetchOptions: { signal: AbortSignal.timeout(6_000) } });
    const detected = (result.raw as { src?: string })?.src?.toLowerCase();
    if (detected) {
      const map: Record<string, LangCode> = {
        pt: 'pt', en: 'en', es: 'es', fr: 'fr', de: 'de',
        it: 'it', ja: 'ja', zh: 'zh', 'zh-cn': 'zh', ru: 'ru', ar: 'ar',
      };
      return map[detected] ?? 'en';
    }
  } catch {}

  return 'en';
}
