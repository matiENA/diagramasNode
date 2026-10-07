const { fetchRange } = require('../utils/sheets');

/**
 * Extrae marcas de tractores y semis desde la planilla Master.
 * SpreadSheet ID: ID_SPREADSHEET_MASTER
 * Rangos: 'TRACTORES'!C2:D y 'SEMIS'!C2:D
 */
async function extractMasterBrands(spreadsheetId) {
    const marcasTractores = {};
    const marcasSemis = {};

    try {
        const [rowsTractores, rowsSemis] = await Promise.all([
            fetchRange(spreadsheetId, "'TRACTORES'!C2:D").catch(() => []),
            fetchRange(spreadsheetId, "'SEMIS'!C2:D").catch(() => [])
        ]);

        rowsTractores.forEach(r => {
            const pat = String(r[0] || '').trim().toUpperCase().replace(/\s+/g, '');
            const marca = String(r[1] || '').trim();
            if (pat && marca && pat !== 'DOMINIO') marcasTractores[pat] = marca;
        });

        rowsSemis.forEach(r => {
            const pat = String(r[0] || '').trim().toUpperCase().replace(/\s+/g, '');
            const marca = String(r[1] || '').trim();
            if (pat && marca && pat !== 'DOMINIO') marcasSemis[pat] = marca;
        });
    } catch (err) {
        console.warn('⚠️ Error extrayendo marcas desde planilla Master:', err.message);
    }

    return { marcasTractores, marcasSemis };
}

module.exports = { extractMasterBrands };
