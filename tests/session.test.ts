import { describe, expect, it } from "vitest";
import { normaliseRoomCode, ROOM_CODE_LENGTH } from "../src/client/session";

describe("saisie d’un code de salle", () => {
  it("met les lettres en majuscules et écarte les caractères ambigus", () => {
    expect(normaliseRoomCode("a-b c2d3")).toBe("ABC2D3");
    expect(normaliseRoomCode("oil01z")).toBe("LZ");
  });

  it("borne toujours le code au format attendu", () => {
    expect(normaliseRoomCode("abcdefgh23456789")).toHaveLength(ROOM_CODE_LENGTH);
    expect(normaliseRoomCode("Àé!")).toBe("");
  });
});
