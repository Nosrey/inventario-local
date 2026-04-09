import React, { useState } from 'react';
import Papa from 'papaparse';
import { getFirestore, doc, writeBatch, runTransaction } from 'firebase/firestore';
import { app } from '../../firebase';

function ExcelImporter({ onImportComplete }) {
    const [products, setProducts] = useState([]);
    const [isProcessing, setIsProcessing] = useState(false);
    const [error, setError] = useState('');
    const [fileName, setFileName] = useState('');

    const handleFileChange = (e) => {
        const file = e.target.files[0];
        if (!file) return;

        setFileName(file.name);
        setError('');
        setProducts([]);

        Papa.parse(file, {
            complete: (result) => {
                const parsedProducts = result.data
                    .map(row => ({
                        name: row[2], // Columna C
                        quantity: parseInt(row[3], 10), // Columna D
                        cost: parseFloat(row[4]), // Columna E
                        price: parseFloat(row[5]), // Columna F
                        minQuantity: parseInt(row[6], 10) // Columna G
                    }))
                    .filter(p => p.name && !isNaN(p.quantity) && !isNaN(p.price)); // Filtrar filas vacías o inválidas

                if (parsedProducts.length === 0) {
                    setError('No se encontraron productos válidos en el archivo. Revisa que las columnas C (nombre) y F (precio) no estén vacías.');
                }
                setProducts(parsedProducts);
            },
            error: (err) => {
                setError(`Error al leer el archivo: ${err.message}`);
            }
        });
    };

    const handleConfirmImport = async () => {
        if (products.length === 0) {
            setError('No hay productos para importar.');
            return;
        }

        setIsProcessing(true);
        setError('');
        const db = getFirestore(app);
        const statsRef = doc(db, 'stats', 'productCounter');
        const inventoryRef = doc(db, 'inventories', 'local'); // Asumimos que el inventario se llama 'local'

        try {
            // 1. Obtener el contador actual de productos en una transacción para seguridad
            const newStartingId = await runTransaction(db, async (transaction) => {
                const statsDoc = await transaction.get(statsRef);
                const currentProductNumber = statsDoc.data()?.productNumber || 0;
                const newProductNumber = currentProductNumber + products.length;
                transaction.update(statsRef, { productNumber: newProductNumber });
                return currentProductNumber + 1;
            });

            // 2. Preparar la carga masiva (batch)
            const batch = writeBatch(db);
            const inventoryUpdates = {};

            products.forEach((product, index) => {
                const newProductId = newStartingId + index;
                const productRef = doc(db, 'products', String(newProductId));

                batch.set(productRef, {
                    id: newProductId,
                    name: product.name,
                    price: product.price,
                    cost: product.cost || 0,
                    minQuantity: product.minQuantity || 0,
                    brandId: null // No tenemos marca en el CSV
                });

                // Añadir la cantidad al objeto de actualización del inventario 'local'
                inventoryUpdates[String(newProductId)] = { quantity: product.quantity };
            });

            // 3. Añadir la actualización del inventario al batch
            // Usamos merge: true para no sobrescribir otros productos que ya existan en el inventario
            batch.set(inventoryRef, { name: 'Local', products: inventoryUpdates }, { merge: true });

            // 4. Ejecutar la carga masiva
            await batch.commit();

            // Notificar al componente padre
            onImportComplete(products.length);
            setProducts([]);
            setFileName('');

        } catch (err) {
            console.error("Error en la carga masiva:", err);
            setError(`Ocurrió un error durante la importación: ${err.message}`);
        } finally {
            setIsProcessing(false);
        }
    };

    return (
        <article>
            <hgroup>
                <h2>Importar Productos desde CSV</h2>
                <h3>Carga masiva de productos a tu inventario.</h3>
            </hgroup>
            <p>
                Selecciona un archivo <code>.csv</code>. Las columnas deben ser: <strong>C:</strong> Nombre, <strong>D:</strong> Cantidad, <strong>E:</strong> Costo, <strong>F:</strong> Precio, <strong>G:</strong> Cantidad Mínima.
            </p>

            <input type="file" accept=".csv" onChange={handleFileChange} />

            {fileName && <p>Archivo seleccionado: <strong>{fileName}</strong></p>}

            {products.length > 0 && (
                <>
                    <h4>Productos a importar ({products.length})</h4>
                    <div style={{ maxHeight: '200px', overflowY: 'auto', marginBottom: '1rem' }}>
                        <table style={{ fontSize: '0.85rem' }}>
                            <thead>
                                <tr>
                                    <th>Nombre</th>
                                    <th>Cantidad</th>
                                    <th>Precio</th>
                                </tr>
                            </thead>
                            <tbody>
                                {products.map((p, i) => (
                                    <tr key={i}>
                                        <td>{p.name}</td>
                                        <td>{p.quantity}</td>
                                        <td>${p.price.toFixed(2)}</td>
                                    </tr>
                                ))}
                            </tbody>
                        </table>
                    </div>
                    <button onClick={handleConfirmImport} aria-busy={isProcessing}>
                        {isProcessing ? 'Importando...' : 'Confirmar Importación'}
                    </button>
                </>
            )}

            {error && <p style={{ color: 'var(--pico-color-red-500)' }}>{error}</p>}
        </article>
    );
}

export default ExcelImporter;