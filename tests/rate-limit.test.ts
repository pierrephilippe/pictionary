import { reset, SELF } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";

interface SessionResponse {
  code: string;
  token: string;
}

const json = async <T>(response: Response): Promise<T> => response.json() as Promise<T>;

const postInvalidJson = (url: string, ip?: string): Promise<Response> => {
  const headers = new Headers({ "content-type": "application/json" });
  if (ip) headers.set("CF-Connecting-IP", ip);
  return SELF.fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify({ unexpected: true }),
  });
};

const expectRateLimited = async (response: Response): Promise<void> => {
  expect(response.status).toBe(429);
  expect(response.headers.get("retry-after")).toBe("60");
  await expect(json<{ error: string }>(response)).resolves.toEqual({
    error: "Trop de requêtes. Réessayez dans une minute.",
  });
};

const expectEventuallyRateLimited = async (
  request: () => Promise<Response>,
  toleratedOvershoot = 12,
): Promise<void> => {
  // Cloudflare rate limiting is deliberately approximate and can allow a
  // small overshoot. Assert bounded activation instead of an exact request.
  for (let attempt = 0; attempt < toleratedOvershoot; attempt += 1) {
    const response = await request();
    if (response.status !== 429) continue;
    await expectRateLimited(response);
    return;
  }
  throw new Error(`Le rate limiter n’a pas bloqué après ${toleratedOvershoot} requêtes supplémentaires.`);
};

describe("Limitation des routes HTTP", () => {
  beforeEach(async () => {
    await reset();
  });

  it("limite les créations par adresse IP sans affecter une autre adresse", async () => {
    for (let index = 0; index < 5; index += 1) {
      const response = await postInvalidJson("https://example.test/api/rooms", "192.0.2.1");
      expect(response.status).toBe(400);
    }

    await expectRateLimited(await postInvalidJson("https://example.test/api/rooms", "192.0.2.1"));
    expect((await postInvalidJson("https://example.test/api/rooms", "192.0.2.2")).status).toBe(400);
  });

  it("utilise une clé restrictive partagée quand CF-Connecting-IP est absent", async () => {
    for (let index = 0; index < 5; index += 1) {
      expect((await postInvalidJson("https://example.test/api/rooms")).status).toBe(400);
    }

    await expectRateLimited(await postInvalidJson("https://example.test/api/rooms"));
  });

  it("limite les tentatives de rejoindre même lorsque le code change", async () => {
    for (let index = 0; index < 40; index += 1) {
      const code = index % 2 === 0 ? "AAAAAA" : "BBBBBB";
      const response = await postInvalidJson(`https://example.test/api/rooms/${code}/join`, "192.0.2.3");
      expect(response.status).toBe(400);
    }

    await expectRateLimited(await postInvalidJson(
      "https://example.test/api/rooms/CCCCCC/join",
      "192.0.2.3",
    ));
  });

  it("limite les tickets par session sans pénaliser une autre session", async () => {
    const roomResponse = await SELF.fetch("https://example.test/api/rooms", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "CF-Connecting-IP": "192.0.2.4",
      },
      body: "{}",
    });
    expect(roomResponse.status).toBe(201);
    const controller = await json<SessionResponse>(roomResponse);

    const joinedResponse = await SELF.fetch(`https://example.test/api/rooms/${controller.code}/join`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "CF-Connecting-IP": "192.0.2.5",
      },
      body: JSON.stringify({ role: "terminal" }),
    });
    expect(joinedResponse.status).toBe(201);
    const terminal = await json<SessionResponse>(joinedResponse);

    const ticket = (token: string): Promise<Response> => SELF.fetch(
      `https://example.test/api/rooms/${controller.code}/ticket`,
      {
        method: "POST",
        headers: {
          Authorization: `Bearer ${token}`,
          "CF-Connecting-IP": "192.0.2.6",
        },
      },
    );

    for (let index = 0; index < 12; index += 1) expect((await ticket(controller.token)).status).toBe(200);
    await expectEventuallyRateLimited(() => ticket(controller.token));
    expect((await ticket(terminal.token)).status).toBe(200);
  });

  it("limite les demandes de ticket non authentifiées avant le Durable Object", async () => {
    const request = (): Promise<Response> => SELF.fetch("https://example.test/api/rooms/AAAAAA/ticket", {
      method: "POST",
      headers: { "CF-Connecting-IP": "192.0.2.7" },
    });

    for (let index = 0; index < 120; index += 1) {
      expect((await request()).status).toBe(401);
    }
    await expectEventuallyRateLimited(request, 24);
  });
});
