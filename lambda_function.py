import json
import logging
import csv
from PIL import Image
import io
import boto3
import email
import requests
from twilio.rest import Client
from fuzzywuzzy import fuzz
import datetime
import time
from email.mime.multipart import MIMEMultipart
from email.mime.text import MIMEText
from email.mime.base import MIMEBase
from email import encoders
import base64


# Configure logging
logger = logging.getLogger()
logger.setLevel(logging.INFO)

# Initialize the S3 client
s3_client = boto3.client('s3')

# Initialize the SES client
ses_client = boto3.client('ses')

# Initialize the SSM client
ssm_client = boto3.client('ssm')

# Retrieve sensitive data and configuration parameters from Parameter Store
def get_parameter(parameter_name):
    try:
        response = ssm_client.get_parameter(Name=parameter_name, WithDecryption=True)
        return response['Parameter']['Value']
    except Exception as e:
        logger.error(f'Error retrieving parameter {parameter_name}: {str(e)}')
        return None

# Retrieve sensitive data and configuration parameters from Parameter Store
plate_recognizer_token = get_parameter('/LicensePlateRecognition/PlateRecognizerToken')
ses_sender_email = get_parameter('/LicensePlateRecognition/SESSenderEmail')
ses_email_notification_to = get_parameter('/LicensePlateRecognition/SESEmailNotificationTo')
twilio_account_sid = get_parameter('/LicensePlateRecognition/TwilioAccountSID')
twilio_auth_token = get_parameter('/LicensePlateRecognition/TwilioAuthToken')
twilio_from_phone_number = get_parameter('/LicensePlateRecognition/TwilioFromPhoneNumber')
twilio_to_phone_number = get_parameter('/LicensePlateRecognition/TwilioToPhoneNumber')  # Retrieve Twilio To phone number from SSM
s3_bucket_name = get_parameter('/LicensePlateRecognition/S3BucketName')
s3_file_key = get_parameter('/LicensePlateRecognition/S3FileKey')
fuzzy_match_threshold = int(get_parameter('/LicensePlateRecognition/FuzzyMatchThreshold'))
raw_inbound_email_bucket = get_parameter('/LicensePlateRecognition/RawInboundEmailBucket')  # Ensure this parameter exists in SSM


# Send an email notification using SES with execution time and a smaller attachment
def send_email_notification(recipient, subject, message_body, script_start_time):
    try:
        # Include explanatory text, script start time, and elapsed time in the email body
        current_time = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        elapsed_time = time.time() - start_time  # Calculate the elapsed time
        elapsed_time_formatted = f'{elapsed_time:.1f}'  # Format elapsed time to one decimal place
        message_body_with_time = (
            f'### Script Start Time: {script_start_time} ###\n\n'
            f'{message_body}\n\n'
            f'Current Time: {current_time}\n'
            f'Elapsed Time: {elapsed_time_formatted} seconds'
        )

        # Create a MIME email message with attachments
        msg = MIMEMultipart()
        msg['From'] = ses_sender_email
        msg['To'] = recipient
        msg['Subject'] = subject

        # Attach the message body
        msg.attach(MIMEText(message_body_with_time, 'plain'))

        # Open and resize the image
        with open('/tmp/attachment.jpg', 'rb') as attachment_file:
            img = Image.open(attachment_file)
            img.thumbnail((300, 300))  # Resize the image to fit within a 300x300 pixel box
            img_byte_array = io.BytesIO()
            img.save(img_byte_array, format='JPEG')
            img_data = img_byte_array.getvalue()

        # Attach the resized image
        attachment = MIMEBase('application', 'octet-stream')
        attachment.set_payload(img_data)
        encoders.encode_base64(attachment)
        attachment.add_header('Content-Disposition', f'attachment; filename=attachment.jpg')
        msg.attach(attachment)

        # Send the email
        raw_message = msg.as_string()
        response = ses_client.send_raw_email(
            Source=ses_sender_email,
            Destinations=[recipient],
            RawMessage={'Data': raw_message}
        )

        logger.info(f'SES Email sent with execution time and attachment: {response["MessageId"]}')
    except Exception as e:
        logger.error(f'Error sending SES email: {str(e)}')



# Make a Twilio call to open the gate
def make_twilio_call(registered_to):
    try:
        twilio_to_number = twilio_to_phone_number  # Retrieve Twilio To phone number from SSM
        twilio_from_number = twilio_from_phone_number
        
        # Customize your call message
        call_message = f"Match found! This vehicle is registered to {registered_to}."
        
        # Make the Twilio call
        twilio_client = Client(twilio_account_sid, twilio_auth_token)
        call = twilio_client.calls.create(
            url="http://demo.twilio.com/docs/voice.xml",
            to=twilio_to_number,
            from_=twilio_from_number,
            twiml=f'<Response><Say>{call_message}</Say></Response>'
        )
        
        logger.info(f'Twilio call SID: {call.sid}')
    except Exception as e:
        logger.error(f'Error making Twilio call: {str(e)}')

# Lambda handler function
def lambda_handler(event, context):
    script_start_time = datetime.datetime.now().strftime("%Y-%m-%d %H:%M:%S")  # Record the script start time
    start_time = time.time()  # Record the start time
    try:
        for record in event.get('Records', []):
            # Extract email information from the event record
            ses_event = record.get('ses', {}).get('mail', {})
            message_id = ses_event.get('messageId')
            
            # Log the event for inspection
            logger.info(f'Email Message Id: {message_id}')

            # Download the email content from the source S3 bucket
            s3_client.download_file(raw_inbound_email_bucket, message_id, '/tmp/email.eml')

            # Parse the email and find attachments
            with open('/tmp/email.eml', 'rb') as email_file:
                msg = email.message_from_binary_file(email_file)
                for part in msg.walk():
                    if part.get_content_maintype() == 'multipart':
                        continue
                    filename = part.get_filename()
                    if filename:
                        # Save the attachment to a temporary file
                        with open('/tmp/attachment.jpg', 'wb') as attachment_file:
                            attachment_file.write(part.get_payload(decode=True))
                        
                        # Upload the attachment to the Plate Recognizer API using requests
                        regions = ["ie"]  # Change to your country
                        with open('/tmp/attachment.jpg', 'rb') as fp:
                            response = requests.post(
                                'https://api.platerecognizer.com/v1/plate-reader/',
                                data=dict(regions=regions),  # Optional
                                files=dict(upload=fp),
                                headers={'Authorization': f'Token {plate_recognizer_token}'})
                            
                            # Log the response from Plate Recognizer API
                            response_text = response.text
                            logger.info(f'Plate Recognizer API Response Status Code: {response.status_code}')
                            logger.info(f'Plate Recognizer API Response: {response_text}')
                            
                            # Extract the recognized plate value from the API response
                            plate_recognized = None
                            try:
                                response_data = json.loads(response_text)
                                if 'results' in response_data:
                                    first_result = response_data['results'][0]
                                    plate_recognized = first_result.get('plate', '').lower()
                                if 'score' in first_result:
                                    score = float(first_result.get('score'))
                                else:
                                    score = 0.0  # Default score if not found
                            except Exception as e:
                                logger.error(f'Error extracting recognized plate: {str(e)}')

                            # Now, retrieve the CSV file from S3 and store its contents in a dictionary
                            csv_content = s3_client.get_object(Bucket=s3_bucket_name, Key=s3_file_key)['Body'].read().decode('utf-8')
                            
                            # Initialize an empty dictionary to store the CSV data
                            csv_data = {}

                            # Parse the CSV content line by line
                            csv_reader = csv.reader(io.StringIO(csv_content))
                            for row in csv_reader:
                                if len(row) >= 2:
                                    key, value = row[0].strip(), row[1].strip()
                                    csv_data[key.lower()] = value.lower()
                            
                            # Log the results
                            logger.info('CSV data for authorised licence plate numbers:')
                            logger.info(csv_data)
                            
                            # Compare the recognized plate to the values in the CSV (including fuzzy matching)
                            best_match = None
                            for csv_key in csv_data.keys():
                                match_score = fuzz.partial_ratio(plate_recognized, csv_key)
                                if match_score >= fuzzy_match_threshold:
                                    best_match = csv_key
                                    break

                            if best_match is not None:
                                matched_value = csv_data.get(best_match, '')
                                logger.info(f'Match found for vehicle license plate number: {plate_recognized}, Registered to: {matched_value}')
                                
                                # Send an email notification when a match is found
                                if score == 1.0:
                                    send_email_notification(ses_email_notification_to, f'Gate Opening Alert - Exact Match Found for Plate: {plate_recognized}',
                                                            f'Registered to: {matched_value}', script_start_time)
                                    make_twilio_call(matched_value)  # Make a Twilio call for both exact and fuzzy matches to open the gate
                                else:
                                    send_email_notification(ses_email_notification_to, f'Gate Opening Alert - Fuzzy Match Found for Plate: {plate_recognized}',
                                                            f'Registered to: {matched_value}', script_start_time)
                                    make_twilio_call(matched_value)  # Make a Twilio call for both exact and fuzzy matches to open the gate
                            else:
                                logger.info(f'No match found for vehicle license plate number: {plate_recognized}')
                                
                                # Send an email notification when no match is found for debugging, logging, and alerting purposes
                                send_email_notification(ses_email_notification_to, f'Failed Gate Opening Alert - No Match Found for Plate: {plate_recognized}',
                                                        'Vehicle not registered', script_start_time)

    except Exception as e:
        # Log the error message
        logger.error(f'Error: {str(e)}')

    return {
        'statusCode': 200,
        'body': json.dumps('Email processing complete.')
    }