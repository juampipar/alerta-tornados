// Paso 3: entrena el modelo (regresión logística) con 2022–2023 y lo prueba con 2024, contra el índice actual.
// Uso: node scripts/entrenar/entrenar.mjs <carpeta datos>   →   <datos>/entrenamiento/modelo.json
// Solo entrena cuando hay al menos el 80% de los casos con ambiente.
import { readFile, writeFile } from 'node:fs/promises';
import { FEATURES, featureRow, trainLogistic, predict, auc } from '../../lib/entrenar.mjs';

const store = (process.argv[2] || '.datos') + '/entrenamiento';
const { casos } = JSON.parse(await readFile(`${store}/casos.json`, 'utf8'));
const amb = JSON.parse(await readFile(`${store}/ambientes.json`, 'utf8').catch(() => '{}'));
const listos = casos.filter((c) => amb[c.id]);
if (Object.keys(amb).length < casos.length * 0.8) {
  console.log(`entrenar: todavía no (${Object.keys(amb).length} de ${casos.length} casos con ambiente)`);
  process.exit(0);
}
const anio = (c) => +c.t.slice(0, 4);
const prueba = listos.filter((c) => anio(c) === 2024), train = listos.filter((c) => anio(c) !== 2024);
const X = (cs) => cs.map((c) => featureRow(amb[c.id])), Y = (cs) => cs.map((c) => c.y);
const m = trainLogistic(X(train), Y(train));
const pTest = X(prueba).map((r) => predict(m, r));
const aucModelo = auc(pTest, Y(prueba));
const aucIndice = auc(prueba.map((c) => amb[c.id].indice), Y(prueba));
// Para mostrar: qué tan alto queda cada caso de prueba con tornado frente a los sin tornado.
const res = {
  generado: new Date().toISOString(),
  features: FEATURES.map(([n]) => n), w: m.w, b: m.b, mean: m.mean, std: m.std,
  n_entrenamiento: train.length, n_prueba: prueba.length,
  tornados_entrenamiento: train.filter((c) => c.y).length, tornados_prueba: prueba.filter((c) => c.y).length,
  auc_modelo: aucModelo && Math.round(aucModelo * 1000) / 1000, auc_indice: aucIndice && Math.round(aucIndice * 1000) / 1000,
  mejora: aucModelo != null && aucIndice != null && aucModelo >= aucIndice + 0.02,
};
await writeFile(`${store}/modelo.json`, JSON.stringify(res, null, 1));
console.log(`modelo: AUC en 2024 ${res.auc_modelo} contra ${res.auc_indice} del índice actual → ${res.mejora ? 'MEJORA, se usa en el panel' : 'no mejora lo suficiente, no se usa'}`);
console.log('pesos (estandarizados):', Object.fromEntries(res.features.map((f, j) => [f, Math.round(m.w[j] * 100) / 100])));
