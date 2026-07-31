const express = require('express');
const { fetchRango, supabase, ID_SPREADSHEET_MASTER } = require('../utils/shared');

module.exports = function createAuthRouter() {
    const router = express.Router();

    router.post('/login', async (req, res) => {
        try {
            const { usuario, password } = req.body || {};
            if (!usuario || !password) {
                return res.json({ success: false, error: "Usuario y contraseña requeridos" });
            }

            const uClean = String(usuario).trim().toLowerCase();
            const pClean = String(password).trim();

            // 1. Validar en Sheets (DB_Usuarios)
            try {
                const rowsUsers = await fetchRango(ID_SPREADSHEET_MASTER, "'DB_Usuarios'!A:C");
                for (let i = 0; i < rowsUsers.length; i++) {
                    let rowU = String(rowsUsers[i][0] || "").trim().toLowerCase();
                    let rowP = String(rowsUsers[i][1] || "").trim();
                    let rol = String(rowsUsers[i][2] || "USER").trim();
                    
                    if (rowU === uClean && rowP === pClean) {
                        return res.json({ 
                            success: true, 
                            token: 'auth_' + Date.now(), 
                            usuario: String(rowsUsers[i][0] || "").trim().toUpperCase(), 
                            rol: rol 
                        });
                    }
                }
            } catch (eSheets) {
                console.error("Error consultando DB_Usuarios en Sheets:", eSheets);
            }

            // 2. Validar en Supabase (usuarios_auth)
            try {
                const { data: user } = await supabase
                    .from('usuarios_auth')
                    .select('id, usuario, rol')
                    .eq('usuario', usuario)
                    .eq('password', password)
                    .single();
                    
                if (user) {
                    return res.json({ 
                        success: true, 
                        token: 'auth_' + user.id + '_' + Date.now(), 
                        usuario: String(user.usuario).toUpperCase(), 
                        rol: user.rol 
                    });
                }
            } catch (eSupa) {
                console.error("Error consultando usuarios_auth en Supabase:", eSupa);
            }

            return res.json({ success: false, error: "Usuario o contraseña incorrectos" });
        } catch (err) {
            console.error("Error en login de servidor:", err);
            return res.status(500).json({ success: false, error: "Error en login de servidor" });
        }
    });

    return router;
};
