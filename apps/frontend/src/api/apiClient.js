import { supabase } from './supabaseClient';

const BASE_API_URL = import.meta.env.VITE_API_URL || '';

/**
 * Cliente de transporte HTTP unificado.
 * Prioriza los endpoints optimizados de Node.js (/api/views/* y /api/diagramas/*)
 * con compresión Gzip nativa y Connection Pooling, con fallback transparente
 * a Supabase client si el backend local no está disponible.
 */
class ApiClient {
  async fetchJson(endpoint, options = {}) {
    const url = `${BASE_API_URL}${endpoint}`;
    try {
      const res = await fetch(url, {
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
          ...options.headers,
        },
        ...options,
      });

      if (!res.ok) {
        throw new Error(`HTTP error ${res.status}: ${res.statusText}`);
      }

      const json = await res.json();
      return json;
    } catch (err) {
      throw err;
    }
  }

  // 1. Vista Diaria Operativa (con paginación y filtros)
  async getDiaria({ limit = 16, offset = 0, servicio, alerta, search } = {}) {
    try {
      const params = new URLSearchParams();
      params.set('limit', String(limit));
      params.set('offset', String(offset));
      if (servicio && servicio !== 'TODOS') params.set('servicio', servicio);
      if (alerta && alerta !== 'TODAS') params.set('alerta', alerta);
      if (search && search.trim()) params.set('search', search.trim());

      const res = await this.fetchJson(`/api/views/diaria?${params.toString()}`);
      if (res && res.success) {
        return {
          drivers: res.datos || [],
          totalCount: res.paginacion?.total || 0,
          hayMas: res.paginacion?.hay_mas ?? false,
        };
      }
    } catch (err) {
      console.warn('⚠️ [ApiClient] Fallback a Supabase para view_diaria_operativa:', err.message);
    }

    // Fallback Supabase
    let query = supabase.from('view_diaria_operativa').select('*', { count: 'exact' });
    if (servicio && servicio !== 'TODOS') query = query.eq('servicio', servicio);
    if (alerta === 'DOCS_VENCIDOS') query = query.eq('alerta_docs_chofer', 'VENCIDO');
    else if (alerta === 'UNIDAD_VENCIDA') query = query.eq('alerta_docs_unidad', 'VENCIDO');
    else if (alerta === 'CUALQUIER_ALERTA') {
      query = query.or('alerta_docs_chofer.eq.VENCIDO,alerta_docs_unidad.eq.VENCIDO,alerta_docs_chofer.eq.POR_VENCER,alerta_docs_unidad.eq.POR_VENCER');
    }
    if (search && search.trim()) {
      const t = search.trim();
      query = query.or(`nombre.ilike.%${t}%,legajo.ilike.%${t}%,dni.ilike.%${t}%,tractor.ilike.%${t}%,semi.ilike.%${t}%,n_ute.ilike.%${t}%`);
    }

    const from = offset;
    const to = offset + limit - 1;
    const { data, count, error } = await query.order('nombre', { ascending: true }).range(from, to);
    if (error) throw error;

    return {
      drivers: data || [],
      totalCount: count || 0,
      hayMas: (data && data.length === limit),
    };
  }

  // 2. Personal que Retorna
  async getPersonalRetorno(fechaTarget) {
    try {
      const res = await this.fetchJson(`/api/views/retorno?fecha=${encodeURIComponent(fechaTarget)}`);
      if (res && res.success) {
        return res.datos || [];
      }
    } catch (err) {
      console.warn('⚠️ [ApiClient] Fallback a RPC Supabase para fn_personal_retorno:', err.message);
    }

    const { data, error } = await supabase.rpc('fn_personal_retorno', { p_fecha: fechaTarget });
    if (error) throw error;
    return data || [];
  }

  // 3. Catálogo de Flota Operativa y Vencimientos
  async getFlota(search = '') {
    try {
      const param = search ? `?search=${encodeURIComponent(search.trim())}` : '';
      const res = await this.fetchJson(`/api/views/flota${param}`);
      if (res && res.success) {
        return res.datos || [];
      }
    } catch (err) {
      console.warn('⚠️ [ApiClient] Fallback a Supabase para view_flota_operativa:', err.message);
    }

    let query = supabase.from('view_flota_operativa').select('*');
    const { data, error } = await query;
    if (error) throw error;
    return data || [];
  }

  // 4. Catálogo Ligero de Choferes (para selector lateral)
  async getCatalogoChoferesLite() {
    try {
      const res = await this.fetchJson('/api/views/catalogo-choferes');
      if (res && res.success) {
        return res.datos || [];
      }
    } catch (err) {
      console.warn('⚠️ [ApiClient] Fallback a Supabase para catalogo-choferes:', err.message);
    }

    const { data, error } = await supabase
      .from('view_individual_chofer')
      .select('chofer_id, nombre, legajo, dni, servicio, foto, telefono, estado_chofer')
      .order('nombre');

    if (error) throw error;
    return (data || []).map((c) => ({
      ...c,
      id: c.chofer_id,
      c_servicio: c.servicio,
      estado: c.estado_chofer,
    }));
  }

  // 5. Ficha Individual de Chofer (unificada con Unidad + Vencimientos + Avalados)
  async getIndividualChofer(choferId) {
    if (!choferId) return null;
    try {
      const res = await this.fetchJson(`/api/views/individual/${encodeURIComponent(choferId)}`);
      if (res && res.success && res.dato) {
        return res.dato;
      }
    } catch (err) {
      console.warn('⚠️ [ApiClient] Fallback a Supabase para view_individual_chofer:', err.message);
    }

    const { data, error } = await supabase
      .from('view_individual_chofer')
      .select('*')
      .eq('chofer_id', choferId)
      .maybeSingle();

    if (error) throw error;
    return data;
  }

  // 6. Calendario Diagrama + KMs
  async getCalendarioDiagramaKm(choferId, zoom = 3, targetTabs = []) {
    if (!choferId) return [];
    try {
      const tabsParam = targetTabs.length ? `&tabs=${encodeURIComponent(targetTabs.join(','))}` : '';
      const res = await this.fetchJson(`/api/views/calendario/${encodeURIComponent(choferId)}?zoom=${zoom}${tabsParam}`);
      if (res && res.success) {
        return res.datos || [];
      }
    } catch (err) {
      console.warn('⚠️ [ApiClient] Fallback a Supabase para view_calendario_diagrama_km:', err.message);
    }

    let query = supabase
      .from('view_calendario_diagrama_km')
      .select('diagrama_id, chofer_id, mes_tab, anio, mes_numero, tira_dias, contabilizador, km_mes_total, cant_viajes_mes, dias_km')
      .eq('chofer_id', choferId);

    if (zoom === 3 && targetTabs.length > 0) {
      query = query.in('mes_tab', targetTabs);
    }

    const { data, error } = await query.order('mes_numero', { ascending: true });
    if (error) throw error;
    return data || [];
  }

  // 7. Cards Diarias / Novedades
  async getCards({ limit = 12, offset = 0, estado, servicio, tipo, search } = {}) {
    try {
      const params = new URLSearchParams();
      params.set('limit', String(limit));
      params.set('offset', String(offset));
      if (estado) params.set('estado', estado);
      if (servicio && servicio !== 'TODOS') params.set('servicio', servicio);
      if (tipo && tipo !== 'TODOS') params.set('tipo', tipo);
      if (search && search.trim()) params.set('search', search.trim());

      const res = await this.fetchJson(`/api/views/cards?${params.toString()}`);
      if (res && res.success) {
        return {
          cards: res.datos || [],
          totalCount: res.paginacion?.total || 0,
          hayMas: res.paginacion?.hay_mas ?? false,
        };
      }
    } catch (err) {
      console.warn('⚠️ [ApiClient] Fallback a Supabase para view_cards_diarias:', err.message);
    }

    let query = supabase.from('view_cards_diarias').select('*', { count: 'exact' });
    if (estado === 'pendientes') query = query.eq('resuelto', false);
    else if (estado === 'resueltas') query = query.eq('resuelto', true);
    if (servicio && servicio !== 'TODOS') query = query.eq('servicio', servicio);
    if (tipo && tipo !== 'TODOS') query = query.eq('tipo', tipo);
    if (search && search.trim()) {
      const term = search.trim();
      query = query.or(`chofer_nombre.ilike.%${term}%,tractor.ilike.%${term}%,n_ute.ilike.%${term}%`);
    }

    const from = offset;
    const to = offset + limit - 1;
    const { data, error, count } = await query
      .order('fecha', { ascending: false, nullsFirst: false })
      .order('creado_el', { ascending: false })
      .range(from, to);

    if (error) throw error;
    return {
      cards: data || [],
      totalCount: count || 0,
      hayMas: (data && data.length === limit),
    };
  }

  // 8. Grilla Operativa Mensual de Diagrama
  async getDiagramaMensual(mesTab = 'Sep-26', servicio = 'TODOS', search = '') {
    try {
      const params = new URLSearchParams();
      params.set('mesTab', mesTab);
      if (servicio && servicio !== 'TODOS') params.set('servicio', servicio);
      if (search && search.trim()) params.set('search', search.trim());

      const res = await this.fetchJson(`/api/views/diagrama?${params.toString()}`);
      if (res && res.success) {
        return res.datos || [];
      }
    } catch (err) {
      console.warn('⚠️ [ApiClient] Fallback a Supabase para view_diagrama_mensual:', err.message);
    }

    let query = supabase.from('view_diagrama_mensual').select('*').eq('mes_tab', mesTab);
    if (servicio && servicio !== 'TODOS') query = query.eq('servicio', servicio);
    const { data, error } = await query.order('chofer_nombre');
    if (error) throw error;
    return data || [];
  }

  // 9. Movimientos Activos (Unidad + Chofer Actual)
  async getMovimientos({ limit = 100, offset = 0, servicio = 'TODOS', estado = 'TODOS', search = '' } = {}) {
    try {
      const params = new URLSearchParams();
      params.set('limit', String(limit));
      params.set('offset', String(offset));
      if (servicio && servicio !== 'TODOS') params.set('servicio', servicio);
      if (estado && estado !== 'TODOS') params.set('estado', estado);
      if (search && search.trim()) params.set('search', search.trim());

      const res = await this.fetchJson(`/api/views/movimientos?${params.toString()}`);
      if (res && res.success) {
        return {
          datos: res.datos || [],
          total: res.paginacion?.total || 0,
          hayMas: res.paginacion?.hay_mas ?? false,
        };
      }
    } catch (err) {
      console.warn('⚠️ [ApiClient] Fallback a Supabase para view_movimientos:', err.message);
    }

    // Fallback Supabase
    let query = supabase.from('view_movimientos').select('*', { count: 'exact' });
    if (servicio && servicio !== 'TODOS') {
      query = query.or(`servicio_unidad.eq.${servicio},chofer_servicio.eq.${servicio}`);
    }
    if (estado && estado !== 'TODOS') {
      query = query.or(`unidad_estado.eq.${estado},chofer_estado.eq.${estado}`);
    }
    if (search && search.trim()) {
      const t = search.trim();
      query = query.or(`chofer_nombre.ilike.%${t}%,chofer_legajo.ilike.%${t}%,chofer_dni.ilike.%${t}%,tractor.ilike.%${t}%,semi.ilike.%${t}%,n_ute.ilike.%${t}%`);
    }

    const from = offset;
    const to = offset + limit - 1;
    const { data, count, error } = await query
      .order('n_ute', { ascending: true, nullsFirst: false })
      .order('tractor', { ascending: true, nullsFirst: false })
      .range(from, to);

    if (error) throw error;
    return {
      datos: data || [],
      total: count || 0,
      hayMas: data && data.length === limit,
    };
  }
}

export const apiClient = new ApiClient();
