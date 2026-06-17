import { useSearchParams } from "react-router-dom";

export function useSearchParamState() {
  const [searchParams, setSearchParams] = useSearchParams();

  const update = (patch: Record<string, string | null>) => {
    const next = new URLSearchParams(searchParams);
    for (const [key, value] of Object.entries(patch)) {
      if (value === null || value === "") {
        next.delete(key);
      } else {
        next.set(key, value);
      }
    }
    setSearchParams(next);
  };

  return { searchParams, update };
}
