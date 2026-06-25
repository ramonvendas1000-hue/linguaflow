import { translate as googleTranslate } from '@vitalets/google-translate-api';
import OpenAI from 'openai';
import type { LangCode } from '../../types/index.js';

export interface TranslationResult {
  text: string;
  provider: 'google' | 'openai' | 'mock';
  ok: boolean;
  detectedLang?: LangCode;
}

// Google Translate uses ISO 639-1 codes — same as our LangCode, except zh needs 'zh-CN'
const GOOGLE_LANG: Record<LangCode, string> = {
  pt: 'pt', en: 'en', es: 'es', fr: 'fr', de: 'de',
  it: 'it', ja: 'ja', zh: 'zh-CN', ru: 'ru', ar: 'ar',
};

// Reverse map: google code → LangCode
const GOOGLE_REVERSE: Record<string, LangCode> = {
  pt: 'pt', en: 'en', es: 'es', fr: 'fr', de: 'de',
  it: 'it', ja: 'ja', zh: 'zh', 'zh-cn': 'zh', ru: 'ru', ar: 'ar',
};

function getOpenAIClient(): OpenAI | null {
  const key = process.env.OPENAI_API_KEY;
  if (!key) return null;
  return new OpenAI({ apiKey: key });
}

async function translateWithGoogle(text: string, from: LangCode, to: LangCode): Promise<string | null> {
  try {
    const result = await googleTranslate(text, {
      from: GOOGLE_LANG[from],
      to:   GOOGLE_LANG[to],
      fetchOptions: { signal: AbortSignal.timeout(8000) },
    });
    return result.text ?? null;
  } catch (err: unknown) {
    console.error('[Google Translate error]', err instanceof Error ? err.message : err);
    return null;
  }
}

async function detectWithGoogle(text: string): Promise<LangCode | null> {
  try {
    const result = await googleTranslate(text, {
      to: 'en',
      fetchOptions: { signal: AbortSignal.timeout(6000) },
    });
    const detected = (result.raw as { src?: string })?.src?.toLowerCase();
    if (!detected) return null;
    return GOOGLE_REVERSE[detected] ?? null;
  } catch {
    return null;
  }
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
          content: `You are a professional translator. Translate the user's text from ${langNames[from]} to ${langNames[to]}. Return ONLY the translated text, no explanations.`,
        },
        { role: 'user', content: text },
      ],
      max_tokens: 500,
    });
    return completion.choices[0]?.message?.content?.trim() ?? null;
  } catch (err: unknown) {
    console.error('[OpenAI translation error]', err instanceof Error ? err.message : err);
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

  // Google Translate — free, no key required
  const google = await translateWithGoogle(text, from, to);
  if (google) return { text: google, provider: 'google', ok: true };

  // OpenAI fallback — only if key is configured
  const openai = await translateWithOpenAI(text, from, to);
  if (openai) return { text: openai, provider: 'openai', ok: true };

  // Both failed — pass through original
  console.error(`[translation] All providers failed: ${from} → ${to}: "${text.slice(0, 40)}"`);
  return { text, provider: 'mock', ok: false };
}

export async function detectLang(text: string): Promise<LangCode> {
  const detected = await detectWithGoogle(text);
  return detected ?? 'en';
}
