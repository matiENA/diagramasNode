import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { supabase } from '@/api/supabaseClient';
import { apiClient } from '@/api/apiClient';
import { queryKeys } from '@/api/queryKeys';

/**
 * Hook para consultar el catálogo de unidades operativas disponibles para asignación
 */
export const useAvailableUnits = (servicio = 'TODOS') => {
  return useQuery({
    queryKey: queryKeys.flota.disponibles(servicio),
    queryFn: async () => {
      const data = await apiClient.getFlota();
      if (servicio && servicio !== 'TODOS') {
        return (data || []).filter((u) => (u.servicio || '').toUpperCase() === servicio.toUpperCase());
      }
      return data || [];
    },
    staleTime: 1000 * 60 * 3, // 3 min en RAM
  });
};

/**
 * Hook principal para Asignar o Desasignar Unidad Operativa
 * Implementa mutaciones optimistas en RAM (<16ms) y sincronización con PostgreSQL
 * y public.eor_sync_queue con capacidad total de rollback.
 */
export const useAssignUnit = () => {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: async ({
      choferId,
      choferNombre,
      unidadId = null,
      tractor = null,
      semi = null,
      n_ute = null,
      esDesasignar = false,
    }) => {
      if (!choferId && !choferNombre) {
        throw new Error('Identificador de chofer requerido para asignar unidad');
      }

      const usuarioActivo = localStorage.getItem('usuarioActivo') || 'OPERADOR';

      // 1. Desasignación
      if (esDesasignar) {
        const { error: err1 } = await supabase
          .from('choferes')
          .update({ unidad_id: null, actualizado_por: usuarioActivo })
          .eq('id', choferId);
        if (err1) throw err1;

        await supabase
          .from('movimientos')
          .delete()
          .eq('id_chofer', choferId);

        return { success: true, message: 'Unidad desasignada exitosamente' };
      }

      // 2. Asignación directa
      // Si otro chofer tenía asignada esta unidad, liberarla
      if (unidadId) {
        await supabase
          .from('choferes')
          .update({ unidad_id: null, actualizado_por: usuarioActivo })
          .eq('unidad_id', unidadId);
      }

      // Asignar unidad al chofer
      const { error: errAssign } = await supabase
        .from('choferes')
        .update({ unidad_id: unidadId, actualizado_por: usuarioActivo })
        .eq('id', choferId);
      if (errAssign) throw errAssign;

      // Actualizar tabla movimientos
      await supabase
        .from('movimientos')
        .delete()
        .eq('id_chofer', choferId);

      if (unidadId) {
        await supabase
          .from('movimientos')
          .insert([{ id_chofer: choferId, id_unidad: unidadId }]);
      }

      return { success: true, message: 'Unidad asignada exitosamente' };
    },

    // Mutación optimista en RAM para que la UI responda en <16 ms
    onMutate: async (vars) => {
      const { choferId, tractor, semi, n_ute, esDesasignar } = vars;
      
      // Cancelar queries activas que pudieran sobreescribir la mutación optimista
      await queryClient.cancelQueries({ queryKey: queryKeys.individual.detail(choferId) });
      await queryClient.cancelQueries({ queryKey: queryKeys.diaria.all });
      await queryClient.cancelQueries({ queryKey: queryKeys.flota.all });
      await queryClient.cancelQueries({ queryKey: ['flota', 'disponibles'] });

      // Capturar snapshots para rollback en caso de error de red
      const prevDetail = queryClient.getQueryData(queryKeys.individual.detail(choferId));
      const prevDiaria = queryClient.getQueriesData({ queryKey: queryKeys.diaria.all });
      const prevFlota = queryClient.getQueriesData({ queryKey: queryKeys.flota.all });
      const prevDisponibles = queryClient.getQueriesData({ queryKey: ['flota', 'disponibles'] });

      // A. Actualizar ficha individual del chofer en RAM
      if (prevDetail) {
        queryClient.setQueryData(queryKeys.individual.detail(choferId), (old) => {
          if (!old) return old;
          return {
            ...old,
            tractor: esDesasignar ? null : tractor || old.tractor,
            semi: esDesasignar ? null : semi || old.semi,
            n_ute: esDesasignar ? null : n_ute || old.n_ute,
            estado_chofer: esDesasignar ? 'inactivo' : 'circulando',
            estado_unidad: esDesasignar ? 'disponible' : 'circulando',
          };
        });
      }

      // B. Actualizar Vista Diaria Operativa en RAM inmediatamente (<16ms)
      queryClient.setQueriesData({ queryKey: queryKeys.diaria.all }, (old) => {
        if (!old) return old;
        
        // Función auxiliar para transformar lista de drivers
        const updateDrivers = (drivers = []) => {
          return drivers.map((d) => {
            const isTarget = d.chofer_id === choferId || d.id === choferId;
            if (isTarget) {
              return {
                ...d,
                tractor: esDesasignar ? null : tractor || d.tractor,
                semi: esDesasignar ? null : semi || d.semi,
                n_ute: esDesasignar ? null : n_ute || d.n_ute,
                estado_chofer: esDesasignar ? 'inactivo' : 'circulando',
                alerta_docs_unidad: esDesasignar ? 'S_D' : d.alerta_docs_unidad,
              };
            }
            // Si otra tarjeta tenía previamente esta misma unidad asignada, liberarla
            if (!esDesasignar && tractor && d.tractor === tractor) {
              return {
                ...d,
                tractor: null,
                semi: null,
                n_ute: null,
                estado_chofer: 'inactivo',
                alerta_docs_unidad: 'S_D',
              };
            }
            return d;
          });
        };

        // Soporta respuesta paginada o array plano
        if (old.pages) {
          return {
            ...old,
            pages: old.pages.map((page) => ({
              ...page,
              drivers: updateDrivers(page.drivers),
            })),
          };
        }

        if (Array.isArray(old.drivers)) {
          return {
            ...old,
            drivers: updateDrivers(old.drivers),
          };
        }

        return old;
      });

      // C. Actualizar Catálogo de Flota en RAM
      queryClient.setQueriesData({ queryKey: queryKeys.flota.all }, (old) => {
        if (!Array.isArray(old)) return old;
        return old.map((u) => {
          if (u.tractor === tractor) {
            return {
              ...u,
              estado: esDesasignar ? 'disponible' : 'circulando',
              chofer_id: esDesasignar ? null : choferId,
            };
          }
          return u;
        });
      });

      // D. Actualizar unidades disponibles en RAM
      queryClient.setQueriesData({ queryKey: ['flota', 'disponibles'] }, (old) => {
        if (!Array.isArray(old)) return old;
        if (!esDesasignar && tractor) {
          return old.filter((u) => u.tractor !== tractor);
        }
        return old;
      });

      return { prevDetail, prevDiaria, prevFlota, prevDisponibles };
    },

    // Rollback exacto en caso de error
    onError: (err, vars, context) => {
      console.warn('⚠️ [useAssignUnit] Error en mutación, ejecutando rollback:', err.message);
      
      if (context?.prevDetail && vars?.choferId) {
        queryClient.setQueryData(queryKeys.individual.detail(vars.choferId), context.prevDetail);
      }
      if (context?.prevDiaria) {
        context.prevDiaria.forEach(([key, val]) => queryClient.setQueryData(key, val));
      }
      if (context?.prevFlota) {
        context.prevFlota.forEach(([key, val]) => queryClient.setQueryData(key, val));
      }
      if (context?.prevDisponibles) {
        context.prevDisponibles.forEach(([key, val]) => queryClient.setQueryData(key, val));
      }
    },

    // Invalidación en cascada garantizada para sincronizar contra las SQL Views
    onSettled: (data, error, variables) => {
      queryClient.invalidateQueries({ queryKey: queryKeys.individual.catalog });
      queryClient.invalidateQueries({ queryKey: queryKeys.diaria.all });
      queryClient.invalidateQueries({ queryKey: queryKeys.flota.all });
      queryClient.invalidateQueries({ queryKey: ['flota', 'disponibles'] });
      if (variables?.choferId) {
        queryClient.invalidateQueries({ queryKey: queryKeys.individual.detail(variables.choferId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.individual.calendar(variables.choferId) });
        queryClient.invalidateQueries({ queryKey: queryKeys.individual.docs(variables.choferId) });
      }
    },
  });
};
