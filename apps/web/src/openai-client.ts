export interface OpenAIImageGenerationRequest {
  model: string;
  prompt: string;
  n?: number;
  size?: string;
  quality?: "auto" | "low" | "medium" | "high";
  response_format?: "url" | "b64_json";
  output_format?: "png" | "jpeg" | "webp";
}

export interface OpenAIImageGenerationResponse {
  created: number;
  data: Array<{
    b64_json?: string;
    url?: string;
    revised_prompt?: string;
  }>;
}

export interface OpenAIImageEditRequest {
  model: string;
  prompt: string;
  image: string;
  n?: number;
  size?: string;
  quality?: "auto" | "low" | "medium" | "high";
  response_format?: "url" | "b64_json";
  output_format?: "png" | "jpeg" | "webp";
}

export async function generateImage(
  apiKey: string,
  baseURL: string,
  request: OpenAIImageGenerationRequest
): Promise<OpenAIImageGenerationResponse> {
  const normalizedBaseURL = baseURL.replace(/\/+$/, "");
  const response = await fetch(`${normalizedBaseURL}/v1/images/generations`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(request)
  });

  if (!response.ok) {
    const error = await readOpenAIError(response);
    throw new Error(error);
  }

  return (await response.json()) as OpenAIImageGenerationResponse;
}

export async function editImage(
  apiKey: string,
  baseURL: string,
  request: OpenAIImageEditRequest
): Promise<OpenAIImageGenerationResponse> {
  const normalizedBaseURL = baseURL.replace(/\/+$/, "");
  const response = await fetch(`${normalizedBaseURL}/v1/images/edits`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`
    },
    body: JSON.stringify(request)
  });

  if (!response.ok) {
    const error = await readOpenAIError(response);
    throw new Error(error);
  }

  return (await response.json()) as OpenAIImageGenerationResponse;
}

async function readOpenAIError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: { message?: string } };
    return body.error?.message || `OpenAI API 请求失败，状态 ${response.status}`;
  } catch {
    return `OpenAI API 请求失败，状态 ${response.status}`;
  }
}
