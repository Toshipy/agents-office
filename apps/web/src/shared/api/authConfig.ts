import { useQuery } from '@tanstack/react-query';
import { api } from './client';

export interface AuthConfig {
  mode: string;
  devRoutes: boolean;
  devAccounts: { username: string; password: string; displayName: string }[];
}

export function useAuthConfig() {
  return useQuery({ queryKey: ['auth-config'], queryFn: () => api.get<AuthConfig>('/v1/auth/config'), staleTime: Infinity });
}
