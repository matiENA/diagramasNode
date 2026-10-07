import { useEffect } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/api/supabaseClient';
import { queryKeys } from '@/api/queryKeys';

/**
 * Hook de sincronización en tiempo real con Supabase Realtime (WebSockets)
 * Escucha cambios en las tablas 'movimientos', 'choferes' y 'unidades'
 * e invalida automáticamente las queries de React Query para que toda la interfaz
 * (tarjetas diarias, tabla de movimientos, flota) refleje los cambios al instante.
 */
export function useRealtimeSync() {
  const queryClient = useQueryClient();

  useEffect(() => {
    const channel = supabase
      .channel('schema-db-changes')
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'movimientos' },
        (payload) => {
          console.log('🔄 [Realtime] Cambio detectado en public.movimientos:', payload.eventType);
          queryClient.invalidateQueries({ queryKey: queryKeys.diaria.all });
          queryClient.invalidateQueries({ queryKey: queryKeys.flota.all });
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'choferes' },
        (payload) => {
          console.log('🔄 [Realtime] Cambio detectado en public.choferes:', payload.eventType);
          queryClient.invalidateQueries({ queryKey: queryKeys.diaria.all });
          queryClient.invalidateQueries({ queryKey: queryKeys.individual.all });
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'diagramas' },
        (payload) => {
          console.log('🔄 [Realtime] Cambio detectado en public.diagramas:', payload.eventType);
          queryClient.invalidateQueries({ queryKey: queryKeys.diaria.all });
          queryClient.invalidateQueries({ queryKey: queryKeys.individual.all });
        }
      )
      .on(
        'postgres_changes',
        { event: '*', schema: 'public', table: 'unidades' },
        (payload) => {
          console.log('🔄 [Realtime] Cambio detectado en public.unidades:', payload.eventType);
          queryClient.invalidateQueries({ queryKey: queryKeys.diaria.all });
          queryClient.invalidateQueries({ queryKey: queryKeys.flota.all });
        }
      )
      .subscribe((status) => {
        if (status === 'SUBSCRIBED') {
          console.log('⚡ [Realtime] Conectado exitosamente al canal en vivo de Supabase');
        }
      });

    return () => {
      supabase.removeChannel(channel);
    };
  }, [queryClient]);
}
