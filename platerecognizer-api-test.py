import requests
from pprint import pprint
regions = ["ie"] # Change to your country
with open('/users/cfinnegan/Downloads/Camera1-1-2.jpg', 'rb') as fp:
    response = requests.post(
        'https://api.platerecognizer.com/v1/plate-reader/',
        data=dict(regions=regions),  #Optional
        files=dict(upload=fp),
        headers={'Authorization': 'Token bfeb12f7144f5ba60362a924f91730dd8eca4595'})

    #For files field, if needed, use imencode method of cv2 library to encode an image and producing a compressed representation that can be easier stored, transmitted, or processed.
    #import cv2
    #success, image_jpg = cv2.imencode('.jpg', fp)
    #files=dict(upload=image_jpg.tostring())

pprint(response.json())