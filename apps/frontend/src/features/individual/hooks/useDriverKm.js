import { useQuery } from '@tanstack/react-query';
import { supabase } from '@/api/supabaseClient';

/**
 * Hook para consultar el historial de viajes y kilómetros de un chofer
 * desde la tabla relacional public.movimientos_km
 */
export const useDriverKm = (choferId, mesesVentana = 12) => {
  return useQuery({
    queryKey: ['driver_trips_km', choferId, mesesVentana],
    queryFn: async () => {
      if (!choferId) return { trips: [], tripsMap: {}, totalKm: 0 };

      let query = supabase
        .from('view_calendario_km')
        .select('fecha, km_totales, hoja_ruta, dominio')
        .eq('id_chofer', choferId);

      // Delimitar a la ventana de visualización relevante para evitar descargar años históricos innecesarios
      if (mesesVentana) {
        const cutoff = new Date();
        cutoff.setMonth(cutoff.getMonth() - mesesVentana);
        const cutoffIso = cutoff.toISOString().split('T')[0];
        query = query.gte('fecha', cutoffIso);
      }

      const { data, error } = await query.order('fecha', { ascending: false });

      if (error) {
        console.warn('Error fetching driver km:', error);
        return { trips: [], tripsMap: {}, totalKm: 0 };
      }

      const trips = data || [];
      const tripsMap = {};
      let totalKm = 0;

      trips.forEach((t) => {
        const iso = String(t.fecha).substring(0, 10);
        const km = parseFloat(t.km_totales) || 0;
        totalKm += km;
        tripsMap[iso] = {
          km,
          hr: Array.isArray(t.hoja_ruta) ? t.hoja_ruta.join(', ') : (t.hoja_ruta || ''),
          dominio: t.dominio || '',
        };
      });

      return {
        trips,
        tripsMap,
        totalKm: Math.round(totalKm * 100) / 100,
      };
    },
    enabled: Boolean(choferId),
    staleTime: 1000 * 60 * 10, // 10 min en RAM
    gcTime: 1000 * 60 * 30,
  });
};
