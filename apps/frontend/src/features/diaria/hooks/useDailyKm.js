import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/api/supabaseClient';
import { queryKeys } from '@/api/queryKeys';

/**
 * Hook para consultar los kilómetros y hojas de ruta de todos los choferes para una fecha contexto
 */
export const useDailyKm = (fechaContexto) => {
  return useQuery({
    queryKey: queryKeys.diaria.km(fechaContexto),
    queryFn: async () => {
      if (!fechaContexto) return {};

      const { data, error } = await supabase
        .from('view_calendario_km')
        .select('id_chofer, km_totales, hoja_ruta, dominio')
        .eq('fecha', fechaContexto);

      if (error) {
        console.warn('Error fetching daily km:', error);
        return {};
      }

      const map = {};
      (data || []).forEach((row) => {
        if (row.id_chofer) {
          map[row.id_chofer] = {
            km_totales: parseFloat(row.km_totales) || 0,
            hoja_ruta: Array.isArray(row.hoja_ruta) ? row.hoja_ruta.join(', ') : (row.hoja_ruta || ''),
            dominio: row.dominio || '',
          };
        }
      });

      return map;
    },
    staleTime: 1000 * 60 * 5, // 5 min en RAM
    gcTime: 1000 * 60 * 20,
    enabled: Boolean(fechaContexto),
  });
};
