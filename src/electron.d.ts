interface FilmLoadResult {
  ok: boolean;
  dataBase64?: string;
  path?: string;
  error?: string;
  canceled?: boolean;
  bytes?: number;
  warning?: string;
}

interface FilmManagerApi {
  loadData: () => Promise<FilmLoadResult>;
  saveData: (dataBase64: string) => Promise<FilmLoadResult>;
  pickDataFile: () => Promise<FilmLoadResult>;
}

interface Window {
  filmManagerApi?: FilmManagerApi;
}
