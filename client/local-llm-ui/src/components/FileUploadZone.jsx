FileUploadZonefunction FileUploadZone() {
  const [files, setFiles] = useState([]);
  const [uploading, setUploading] = useState(false);

  const handleDrop = async (e) => {
    e.preventDefault();
    const droppedFiles = Array.from(e.dataTransfer.files);
    
    const formData = new FormData();
    droppedFiles.forEach(file => formData.append('files', file));
    
    setUploading(true);
    const response = await fetch('/upload', {
      method: 'POST',
      body: formData
    });
    
    const result = await response.json();
    setFiles([...files, ...result.files]);
    setUploading(false);
  };

  return (
    <div 
      onDrop={handleDrop}
      onDragOver={(e) => e.preventDefault()}
      className="upload-zone"
    >
      <p>📁 Drag files here or click to browse</p>
      <input 
        type="file" 
        multiple 
        onChange={(e) => handleDrop({ dataTransfer: { files: e.target.files }})}
      />
      
      {files.map(file => (
        <div key={file.id} className="uploaded-file">
          ✅ {file.originalName} ({formatSize(file.size)})
        </div>
      ))}
    </div>
  );
}