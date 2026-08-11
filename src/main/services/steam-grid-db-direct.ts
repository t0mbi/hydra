import axios from "axios";

import type { ArtworkItem, ArtworkKind, ArtworkPage, GameShop } from "@types";

const BASE_URL = "https://www.steamgriddb.com/api/v2";
const ARTWORK_PAGE_SIZE = 50;

const KIND_ENDPOINT: Record<ArtworkKind, string> = {
  grids: "grids",
  heroes: "heroes",
  logos: "logos",
  icons: "icons",
};

const KIND_PARAMS: Record<ArtworkKind, Record<string, string>> = {
  grids: {
    nsfw: "false",
    dimensions: "600x900,342x482,660x930",
    mimes: "image/png,image/jpeg,image/webp",
  },
  heroes: { nsfw: "false", mimes: "image/png,image/jpeg,image/webp" },
  logos: { nsfw: "false", mimes: "image/png,image/webp" },
  icons: { nsfw: "false", mimes: "image/png,image/vnd.microsoft.icon" },
};

interface SteamGridDbApiResponse<T> {
  success: boolean;
  data: T;
  errors?: string[];
}

interface SteamGridDbGame {
  id: number;
  name: string;
}

interface SteamGridDbAsset {
  id: number;
  score: number;
  style?: string;
  width?: number;
  height?: number;
  nsfw?: boolean;
  humor?: boolean;
  notes?: string | null;
  mime?: string;
  language?: string;
  url: string;
  thumb: string;
  tags?: string[];
  author?: { name: string; steam64: string; avatar: string };
}

const createClient = (apiKey: string) =>
  axios.create({
    baseURL: BASE_URL,
    headers: { Authorization: `Bearer ${apiKey}` },
  });

const mapAsset = (asset: SteamGridDbAsset): ArtworkItem => ({
  id: asset.id,
  score: asset.score,
  url: asset.url,
  thumb: asset.thumb,
  width: asset.width ?? 0,
  height: asset.height ?? 0,
  style: asset.style,
  nsfw: asset.nsfw,
  humor: asset.humor,
  notes: asset.notes,
  mime: asset.mime,
  language: asset.language,
  tags: asset.tags,
  author: asset.author,
});

export class SteamGridDbDirectClient {
  private static gameIdCache = new Map<string, number | null>();

  static async validateApiKey(apiKey: string): Promise<void> {
    // SteamGridDB's API has no dedicated "whoami" endpoint reachable with a
    // bare API key, so validation is done by making a cheap real request and
    // checking it isn't rejected as unauthorized.
    await createClient(apiKey).get<SteamGridDbApiResponse<SteamGridDbGame[]>>(
      "/search/autocomplete/a"
    );
  }

  private static async resolveGameId(
    apiKey: string,
    shop: GameShop,
    objectId: string,
    title: string
  ): Promise<number | null> {
    const cacheKey = `${shop}:${objectId}`;
    if (this.gameIdCache.has(cacheKey)) {
      return this.gameIdCache.get(cacheKey)!;
    }

    const client = createClient(apiKey);
    let gameId: number | null = null;

    if (shop === "steam") {
      try {
        const response = await client.get<
          SteamGridDbApiResponse<SteamGridDbGame>
        >(`/games/steam/${objectId}`);
        gameId = response.data.data.id;
      } catch (error) {
        if (!axios.isAxiosError(error) || error.response?.status !== 404) {
          throw error;
        }
      }
    }

    if (gameId === null) {
      const response = await client.get<
        SteamGridDbApiResponse<SteamGridDbGame[]>
      >(`/search/autocomplete/${encodeURIComponent(title)}`);

      const candidates = response.data.data ?? [];
      const exactMatch = candidates.find(
        (candidate) => candidate.name.toLowerCase() === title.toLowerCase()
      );

      gameId = (exactMatch ?? candidates[0])?.id ?? null;
    }

    this.gameIdCache.set(cacheKey, gameId);
    return gameId;
  }

  static async fetchArtworkDirect(
    apiKey: string,
    shop: GameShop,
    objectId: string,
    kind: ArtworkKind,
    page: number,
    title: string
  ): Promise<ArtworkPage> {
    const gameId = await this.resolveGameId(apiKey, shop, objectId, title);

    if (gameId === null) {
      return { items: [], cache: "fresh", hasMore: false };
    }

    const client = createClient(apiKey);
    const response = await client.get<
      SteamGridDbApiResponse<SteamGridDbAsset[]>
    >(`/${KIND_ENDPOINT[kind]}/game/${gameId}`, { params: KIND_PARAMS[kind] });

    const allItems = (response.data.data ?? []).map(mapAsset);
    const start = page * ARTWORK_PAGE_SIZE;
    const items = allItems.slice(start, start + ARTWORK_PAGE_SIZE);

    return {
      items,
      cache: "fresh",
      hasMore: start + ARTWORK_PAGE_SIZE < allItems.length,
    };
  }
}
