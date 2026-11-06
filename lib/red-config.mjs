// Conexión a Supabase (red de tormentas). La clave publishable es pública por diseño:
// lo que cada uno puede hacer lo deciden las políticas de la base (RLS), no esta clave.
export const SUPA_URL = 'https://yqppzogcaoxhsmgtghqi.supabase.co';
export const SUPA_KEY = 'sb_publishable_zABwa6gSQtj02_XoJRbTZg_xezujVnR';
export const fotoUrl = (path) => `${SUPA_URL}/storage/v1/object/public/fotos/${path}`;
export const QUE_VIO = ['nada', 'lluvia fuerte', 'granizo', 'nube estante', 'nube pared', 'rotación', 'embudo', 'tornado'];
export const FUERTE = ['tornado', 'embudo', 'rotación']; // lo que más sirve para verificar el índice
