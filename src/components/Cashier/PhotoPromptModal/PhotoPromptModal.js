import React, { useState, useRef } from 'react';
import { getStorage, ref as storageRef, uploadBytesResumable, getDownloadURL } from 'firebase/storage';
import { doc, setDoc, serverTimestamp } from 'firebase/firestore';
import { db } from '../../../firebase.js';
import './PhotoPromptModal.css';

function PhotoPromptModal({ isOpen, onClose, product, onPhotoUploaded, onPhotoSkipped, user }) {
  const [uploading, setUploading] = useState(false);
  const [uploadProgress, setUploadProgress] = useState(0);
  const fileInputRef = useRef(null);

  if (!isOpen || !product) return null;

  const handleBackdrop = (e) => {
    if (e.target === e.currentTarget) onClose();
  };

  const handleNoPhoto = () => {
    if (onPhotoSkipped) {
      onPhotoSkipped(product);
    } else {
      onClose();
    }
  };

  const handleYesPhoto = () => {
    fileInputRef.current?.click();
  };

  const handleCancelUpload = () => {
    // Cancel upload and reset state
    setUploading(false);
    setUploadProgress(0);
    // Clear any ongoing upload tasks if needed
    if (fileInputRef.current) {
      fileInputRef.current.value = '';
    }
    // Close modal
    onClose();
  };

  const handleFileSelect = async (e) => {
    const files = Array.from(e.target.files);
    if (files.length === 0) return;

    setUploading(true);
    setUploadProgress(0);

    try {
      const storage = getStorage();
      const productId = product.docId || product.id;
      
      // Helper function to compress image
      const compressImage = async (file, maxWidth = 1080, quality = 0.8) => {
        return new Promise((resolve) => {
          const img = new Image();
          img.onload = () => {
            const canvas = document.createElement('canvas');
            const scale = Math.min(1, maxWidth / Math.max(img.width, img.height));
            canvas.width = Math.max(1, Math.round(img.width * scale));
            canvas.height = Math.max(1, Math.round(img.height * scale));
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            canvas.toBlob(resolve, 'image/jpeg', quality);
          };
          img.onerror = () => resolve(file);
          img.src = URL.createObjectURL(file);
        });
      };

      // Helper function to create thumbnail
      const createThumbnail = async (file, maxSize = 300, quality = 0.8) => {
        return new Promise((resolve) => {
          const img = new Image();
          img.onload = () => {
            const canvas = document.createElement('canvas');
            const scale = Math.min(1, maxSize / Math.max(img.width, img.height));
            canvas.width = Math.max(1, Math.round(img.width * scale));
            canvas.height = Math.max(1, Math.round(img.height * scale));
            const ctx = canvas.getContext('2d');
            ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
            canvas.toBlob(resolve, 'image/webp', quality);
          };
          img.onerror = () => resolve(file);
          img.src = URL.createObjectURL(file);
        });
      };

      const uploaded = { full: [], thumbsWebp: [] };

      for (let i = 0; i < files.length; i++) {
        const file = files[i];
        if (!file.type.startsWith('image/')) continue;

        const baseName = `${Date.now()}_${file.name.replace(/[^a-zA-Z0-9.\-]/g, '_')}`;

        // Compress and upload full image
        const compressedFull = await compressImage(file);
        const fullName = `${baseName}_full.jpg`;
        const fullRef = storageRef(storage, `products/${productId}/${fullName}`);
        const fullMetadata = { contentType: 'image/jpeg', cacheControl: 'public, max-age=31536000' };
        
        const fullTask = uploadBytesResumable(fullRef, compressedFull, fullMetadata);
        await new Promise((resolve, reject) => {
          fullTask.on('state_changed', 
            (snap) => {
              const pct = snap.totalBytes ? (snap.bytesTransferred / snap.totalBytes) * 100 : 0;
              setUploadProgress(Math.round(pct));
            },
            reject,
            async () => {
              try {
                const url = await getDownloadURL(fullRef);
                uploaded.full.push(url);
                resolve();
              } catch (e) {
                reject(e);
              }
            }
          );
        });

        // Create and upload thumbnail
        const thumbnail = await createThumbnail(file);
        const thumbName = `${baseName}_thumb.webp`;
        const thumbRef = storageRef(storage, `products/${productId}/${thumbName}`);
        const thumbMetadata = { contentType: 'image/webp', cacheControl: 'public, max-age=31536000' };
        
        const thumbTask = uploadBytesResumable(thumbRef, thumbnail, thumbMetadata);
        await new Promise((resolve, reject) => {
          thumbTask.on('state_changed', 
            (snap) => {
              const pct = snap.totalBytes ? (snap.bytesTransferred / snap.totalBytes) * 100 : 0;
              setUploadProgress(Math.round(pct));
            },
            reject,
            async () => {
              try {
                const url = await getDownloadURL(thumbRef);
                uploaded.thumbsWebp.push(url);
                resolve();
              } catch (e) {
                reject(e);
              }
            }
          );
        });
      }

      // Update product document with image URLs
      await setDoc(doc(db, 'products', productId), {
        images: uploaded.full,
        thumbnailsWebp: uploaded.thumbsWebp,
        image: uploaded.full[0] || null,
        thumbnail: uploaded.thumbsWebp[0] || null,
        thumbnailWebp: uploaded.thumbsWebp[0] || null,
        updatedAt: serverTimestamp()
      }, { merge: true });

      // Create updated product object with new photos
      const updatedProduct = {
        ...product,
        images: uploaded.full,
        thumbnailsWebp: uploaded.thumbsWebp,
        image: uploaded.full[0] || null,
        thumbnail: uploaded.thumbsWebp[0] || null,
        thumbnailWebp: uploaded.thumbsWebp[0] || null,
      };

      if (onPhotoUploaded) {
        onPhotoUploaded(updatedProduct, uploaded);
      }
      onClose();
    } catch (error) {
      console.error('Error uploading photos:', error);
      alert('Error al subir las fotos. Por favor intenta de nuevo.');
    } finally {
      setUploading(false);
      setUploadProgress(0);
      // Clear file input
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  return (
    <div className="photo-prompt-backdrop" onClick={handleBackdrop}>
      <div className="photo-prompt-modal">
        {!uploading ? (
          <>
            <div className="photo-prompt-header">
              <h3>¿Añadir foto al producto?</h3>
              <button className="photo-prompt-close" onClick={onClose}>×</button>
            </div>
            
            <div className="photo-prompt-content">
              <p>El producto <strong>"{product.name}"</strong> no tiene fotos.</p>
              <p>¿Deseas añadir una foto ahora?</p>
            </div>

            <div className="photo-prompt-actions">
              <button className="photo-prompt-btn secondary" onClick={handleNoPhoto}>
                No, continuar sin foto
              </button>
              <button className="photo-prompt-btn primary" onClick={handleYesPhoto}>
                Sí, añadir foto
              </button>
            </div>
          </>
        ) : (
          <div className="photo-prompt-upload">
            <div className="photo-prompt-header">
              <h3>Subiendo foto</h3>
              <button className="photo-prompt-close" onClick={handleCancelUpload}>×</button>
            </div>
            
            <div className="upload-progress">
              <div className="progress-bar">
                <div 
                  className="progress-fill" 
                  style={{ width: `${uploadProgress}%` }}
                ></div>
              </div>
              <p>Subiendo foto... {uploadProgress}%</p>
              <p className="upload-status">Por favor espera mientras se procesa la imagen</p>
            </div>
          </div>
        )}

        <input
          ref={fileInputRef}
          type="file"
          accept="image/*"
          capture="environment"
          multiple
          onChange={handleFileSelect}
          style={{ display: 'none' }}
        />
      </div>
    </div>
  );
}

export default PhotoPromptModal;
