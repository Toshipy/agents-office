import { useQuery } from '@tanstack/react-query';
import { api } from './client';

export interface AuthConfig {
  mode: string;
  devRoutes: boolean;
  /** 新規登録できるか（サーバーでは最初の 1 人だけ等） */
  signup?: boolean;
  /** 新規登録に登録コードが必要か */
  signupCodeRequired?: boolean;
  devAccounts: { username: string; password: string; displayName: string }[];
}

export function useAuthConfig() {
  return useQuery({ queryKey: ['auth-config'], queryFn: () => api.get<AuthConfig>('/v1/auth/config'), staleTime: Infinity });
}
