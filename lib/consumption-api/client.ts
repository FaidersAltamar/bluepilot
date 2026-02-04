type JsonRecord = Record<string, unknown>;

export interface ConsumptionApiConfig {
  baseUrl: string;
  apiKey?: string;
  chatPath: string;
  classifyPath: string;
  extraHeaders?: Record<string, string>;
}

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not configured`);
  return v;
}

function optionalJsonHeaders(envName: string): Record<string, string> | undefined {
  const raw = process.env[envName];
  if (!raw) return undefined;
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error('must be an object');
    }
    const result: Record<string, string> = {};
    for (const [k, v] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof v !== 'string') continue;
      result[k] = v;
    }
    return result;
  } catch (e) {
    throw new Error(
      `${envName} must be valid JSON object of string:string headers`
    );
  }
}

export function getConsumptionApiConfig(): ConsumptionApiConfig {
  const baseUrl = requiredEnv('CONSUMPTION_API_BASE_URL').replace(/\/$/, '');
  const apiKey = process.env.CONSUMPTION_API_KEY;
  const chatPath = process.env.CONSUMPTION_API_CHAT_PATH || '/chat/steps';
  const classifyPath =
    process.env.CONSUMPTION_API_PROJECT_CLASSIFY_PATH || '/project/classify';
  const extraHeaders = optionalJsonHeaders('CONSUMPTION_API_HEADERS_JSON');

  return { baseUrl, apiKey, chatPath, classifyPath, extraHeaders };
}

function buildHeaders(config: ConsumptionApiConfig): Headers {
  const h = new Headers();
  h.set('Content-Type', 'application/json');
  if (config.apiKey) h.set('Authorization', `Bearer ${config.apiKey}`);
  if (config.extraHeaders) {
    for (const [k, v] of Object.entries(config.extraHeaders)) h.set(k, v);
  }
  return h;
}

async function throwIfNotOk(res: Response): Promise<void> {
  if (res.ok) return;
  const contentType = res.headers.get('content-type') || '';
  let bodyText = '';
  try {
    bodyText =
      contentType.includes('application/json') || contentType.includes('text/')
        ? await res.text()
        : '';
  } catch {
    // ignore
  }
  throw new Error(
    `Consumption API error ${res.status} ${res.statusText}${bodyText ? `: ${bodyText}` : ''}`
  );
}

export async function consumptionChatSteps(input: {
  messages: unknown;
  metadata?: JsonRecord;
}): Promise<
  | { kind: 'stream'; stream: ReadableStream<Uint8Array>; contentType?: string }
  | { kind: 'json'; data: unknown }
> {
  const config = getConsumptionApiConfig();
  const url = `${config.baseUrl}${config.chatPath.startsWith('/') ? '' : '/'}${config.chatPath}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(config),
    body: JSON.stringify({
      messages: input.messages,
      metadata: input.metadata,
    }),
  });

  await throwIfNotOk(res);

  const contentType = res.headers.get('content-type') || undefined;

  // If upstream streams (SSE or chunked), just pass-through.
  if (res.body) {
    const isStreamingLike =
      (contentType && contentType.includes('text/event-stream')) ||
      (contentType && contentType.includes('application/x-ndjson')) ||
      (contentType && contentType.includes('text/plain'));

    if (isStreamingLike) {
      return { kind: 'stream', stream: res.body, contentType };
    }
  }

  // Otherwise parse as JSON and let the route decide how to return it.
  const data = await res.json();
  return { kind: 'json', data };
}

export async function consumptionClassifyProject(input: {
  prompt: string;
  metadata?: JsonRecord;
}): Promise<{ template: string; title?: string }> {
  const config = getConsumptionApiConfig();
  const url = `${config.baseUrl}${config.classifyPath.startsWith('/') ? '' : '/'}${config.classifyPath}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: buildHeaders(config),
    body: JSON.stringify({
      prompt: input.prompt,
      metadata: input.metadata,
    }),
  });

  await throwIfNotOk(res);

  const data = (await res.json()) as unknown;

  // Accept either {template,title} or {data:{template,title}}
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    const direct = data as Record<string, unknown>;
    const nested =
      direct.data && typeof direct.data === 'object' && !Array.isArray(direct.data)
        ? (direct.data as Record<string, unknown>)
        : undefined;
    const source = nested || direct;
    const template = source.template;
    const title = source.title;
    if (typeof template === 'string') {
      return { template, title: typeof title === 'string' ? title : undefined };
    }
  }

  throw new Error('Consumption API classify response missing {template,title}');
}

