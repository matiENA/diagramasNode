const express = require('express');

/**
 * Router dedicado para el Dashboard.
 * Expone endpoints ligeros que devuelven solo lo que DASH necesita,
 * sin enviar la estructura completa de diagramas/días/ISO.
 */
module.exports = function createDashRouter(cacheDatosGlobales) {
    const router = express.Router();

    // GET /api/dash/flota — Lista ligera para autocompletado y enriquecimiento
    // Devuelve solo: nom, tractor, semi, srv, n_ute (sin dias ni _diasIso)
    router.get('/flota', (req, res) => {
        if (!cacheDatosGlobales.diagramas || !cacheDatosGlobales.diagramas.diagramas) {
            return res.status(503).json({ error: "Cargando DB..." });
        }

        const flotaLite = cacheDatosGlobales.diagramas.diagramas.map(ch => ({
            nom: ch.nom,
            tractor: ch.tractor || '',
            semi: ch.semi || '',
            srv: ch.srv || '',
            n_ute: ch.n_ute || ''
        }));

        res.json({
            success: true,
            flota: flotaLite,
            // Flota indexada por nombre normalizado para búsqueda rápida
            flotaMap: cacheDatosGlobales.diagramas.flota || {},
            usuarios: cacheDatosGlobales.usuarios || [],
            timestamp: cacheDatosGlobales.ultimaActualizacion
        });
    });

    // GET /api/dash/novedades — Novedades para el Dashboard
    router.get('/novedades', (req, res) => {
        res.json({
            success: true,
            data: cacheDatosGlobales.novedades || []
        });
    });

    // GET /api/dash/usuarios — Lista de usuarios para @menciones
    router.get('/usuarios', (req, res) => {
        res.json({
            success: true,
            data: cacheDatosGlobales.usuarios || []
        });
    });

    return router;
};
