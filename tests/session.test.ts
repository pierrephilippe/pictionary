import { afterEach, describe, expect, it, vi } from "vitest";
import { normaliseRoomCode, requestJson, ROOM_CODE_LENGTH } from "../src/client/session";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("saisie d’un code de salle", () => {
  it("met les lettres en majuscules et écarte les caractères ambigus", () => {
    expect(normaliseRoomCode("a-b c2d3")).toBe("ABC2D3");
    expect(normaliseRoomCode("oil01z")).toBe("LZ");
  });

  it("borne toujours le code au format attendu", () => {
    expect(normaliseRoomCode("abcdefgh23456789")).toHaveLength(ROOM_CODE_LENGTH);
    expect(normaliseRoomCode("Àé!")).toBe("");
  });

  it("interrompt une requête réseau qui ne répond pas", async () => {
    vi.stubGlobal("fetch", vi.fn((_input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => {
        reject(init.signal?.reason ?? new DOMException("Aborted", "AbortError"));
      }, { once: true });
    })));

    await expect(requestJson("/api/test", {}, 5)).rejects.toThrow("Le serveur met trop de temps à répondre.");
  });
});
