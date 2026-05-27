# Usa una imagen ligera de Node.js
FROM node:20-alpine

# Instala FFmpeg y sus dependencias necesarias para procesamiento de video/audio
# También es útil agregar git si se requieren repositorios en package.json
RUN apk update && apk add --no-cache ffmpeg

# Establece el directorio de trabajo
WORKDIR /app

# Copia los archivos de definición de dependencias
COPY package*.json ./

# Instala las dependencias
RUN npm install

# Copia el resto del código
COPY . .

# Crea el directorio de subidas y establece permisos 
# (Aunque el volumen de docker-compose lo sobrescribirá, garantiza que no falle sin volumen)
RUN mkdir -p /app/uploads && chmod 777 /app/uploads

# Expone el puerto de la aplicación
EXPOSE 3000

# Comando para iniciar la aplicación
CMD ["npm", "start"]
